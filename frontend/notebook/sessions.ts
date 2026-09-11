import { KernelMessage, type Kernel, type ServiceManager } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';

const RUNNING_TARGET = 'dolphindb-extension:running-session';
const NOTEBOOK_TARGET = 'dolphindb-extension:notebook';
interface SessionState {
  kind: 'state' | 'running-session'; locked: boolean; busy: boolean; error: string | null;
  profile: { id: string; name: string } | null;
}
interface Watch {
  kernel: Kernel.IKernelConnection; paths: string[]; commId: string | null;
  state: SessionState | null; pending: Promise<void> | null; closing: boolean; generation: number;
  discovery: Kernel.IShellFuture | null;
}

/** Observe existing kernels without executing code or taking over their widget comms. */
export class NotebookSessions {
  readonly changed = new Signal<this, void>(this);
  private watches = new Map<string, Watch>();
  private disposed = false;

  constructor(private services: Pick<ServiceManager.IManager, 'kernels' | 'sessions'>) {
    services.sessions.runningChanged.connect(this.sync, this);
    services.kernels.runningChanged.connect(this.sync, this);
    void Promise.all([services.sessions.ready, services.kernels.ready]).then(() => this.sync());
  }

  get sessions(): Watch[] { return [...this.watches.values()].filter(watch => watch.state?.locked); }

  async refresh(): Promise<void> {
    await Promise.all([this.services.sessions.refreshRunning(), this.services.kernels.refreshRunning()]);
    this.sync();
    await Promise.all([...this.watches.values()].map(watch => this.probe(watch)));
  }

  private sync(): void {
    if (this.disposed) { return; }
    const paths = new Map<string, string[]>();
    for (const session of this.services.sessions.running()) {
      if (session.type !== 'notebook' || !session.kernel) { continue; }
      paths.set(session.kernel.id, [...(paths.get(session.kernel.id) ?? []), session.path]);
    }
    const kernels = new Map([...this.services.kernels.running()].map(kernel => [kernel.id, kernel]));
    for (const [id, watch] of this.watches) {
      if (!kernels.has(id)) { this.cancelProbe(watch); watch.kernel.dispose(); this.watches.delete(id); }
    }
    for (const [id, documents] of paths) {
      if (!kernels.has(id)) { continue; }
      let watch = this.watches.get(id);
      if (!watch) {
        // handleComms=false is essential: this observer must not close widget
        // comm_open messages whose targets are registered by the notebook.
        const kernel = this.services.kernels.connectTo({ model: kernels.get(id)!, handleComms: false });
        watch = { kernel, paths: documents, commId: null, state: null, pending: null, discovery: null, closing: false, generation: 0 };
        this.watches.set(id, watch);
        const current = watch;
        kernel.iopubMessage.connect((_sender, message) => this.receive(current, message));
        kernel.statusChanged.connect((_sender, status) => {
          if (status === 'restarting' || status === 'autorestarting' || status === 'dead') {
            this.cancelProbe(current); current.commId = null; current.state = null; current.closing = false;
          }
          this.changed.emit();
        });
        kernel.connectionStatusChanged.connect((_sender, status) => {
          if (status === 'connected') { void this.probe(current); }
          else { this.cancelProbe(current); }
          this.changed.emit();
        });
        void this.probe(current);
      }
      watch.paths = documents;
    }
    this.changed.emit();
  }

  private cancelProbe(watch: Watch): void {
    // Transport reconnects do not cancel Jupyter futures whose replies were lost.
    // Release both discovery stages without discarding the last known DDB state.
    watch.generation++;
    watch.pending = null;
    const future = watch.discovery;
    watch.discovery = null;
    future?.dispose();
  }

  private probe(watch: Watch): Promise<void> {
    if (watch.pending || watch.kernel.connectionStatus !== 'connected') { return watch.pending ?? Promise.resolve(); }
    const generation = watch.generation;
    const pending = (async () => {
      // Keep the future so a lost comm_info reply can be canceled on disconnect.
      const message = KernelMessage.createMessage<KernelMessage.ICommInfoRequestMsg>({
        msgType: 'comm_info_request', channel: 'shell', username: watch.kernel.username,
        session: watch.kernel.clientId, content: {},
      });
      const request = watch.kernel.sendShellMessage(message, true, true);
      watch.discovery = request;
      const reply = await request.done as KernelMessage.ICommInfoReplyMsg;
      if (this.disposed || this.watches.get(watch.kernel.id) !== watch || generation !== watch.generation) { return; }
      if (reply.content.status !== 'ok') { return; }
      const entries = Object.entries(reply.content.comms);
      // The second target supports already-open kernels from earlier extension versions.
      const comm = entries.find(([, info]) => info.target_name === RUNNING_TARGET)
        ?? entries.find(([, info]) => info.target_name === NOTEBOOK_TARGET);
      watch.commId = comm?.[0] ?? null;
      if (watch.commId) {
        const status = this.send(watch, 'status');
        watch.discovery = status ?? null;
        await status?.done;
      }
      else { watch.state = null; watch.closing = false; this.changed.emit(); }
    })().catch(() => { /* Retain the last known session during a transport outage. */ })
      .finally(() => {
        if (watch.pending === pending) { watch.pending = null; watch.discovery = null; }
      });
    return watch.pending = pending;
  }

  private receive(watch: Watch, message: KernelMessage.IIOPubMessage): void {
    if (KernelMessage.isCommOpenMsg(message) && message.content.target_name === NOTEBOOK_TARGET && !watch.commId) {
      watch.commId = message.content.comm_id;
    }
    if (KernelMessage.isCommCloseMsg(message) && message.content.comm_id === watch.commId) {
      this.cancelProbe(watch); watch.commId = null; watch.state = null; watch.closing = false; this.changed.emit();
    } else if (KernelMessage.isCommMsgMsg(message)) {
      const state = message.content.data as unknown as SessionState;
      // Kernel-owned session notifications are pushed even if a DDB session is
      // created after discovery. Do not poll shells: that prevents idle culling.
      if (state.kind === 'running-session') {
        if (watch.commId !== message.content.comm_id) { this.cancelProbe(watch); }
        watch.commId = message.content.comm_id;
      }
      else if (state.kind !== 'state' || message.content.comm_id !== watch.commId) { return; }
      watch.state = state;
      if (!state.locked) { watch.closing = false; }
      this.changed.emit();
    }
  }

  private send(watch: Watch, kind: 'status' | 'close'): Kernel.IShellFuture | undefined {
    if (!watch.commId) { return; }
    const message = KernelMessage.createMessage<KernelMessage.ICommMsgMsg<'shell'>>({
      msgType: 'comm_msg', channel: 'shell', username: watch.kernel.username,
      session: watch.kernel.clientId, content: { comm_id: watch.commId, data: { kind } },
    });
    // Use the main shell queue, just like %ddb; never race the SDK via a subshell.
    return watch.kernel.sendShellMessage(message, false, true);
  }

  async shutdown(id: string): Promise<void> {
    const watch = this.watches.get(id);
    if (!watch?.state?.locked || watch.closing) { return; }
    watch.closing = true; this.changed.emit();
    try {
      await this.send(watch, 'close')?.done;
      if (watch.state?.locked && watch.state.error) { throw new Error(watch.state.error); }
    } finally { watch.closing = false; this.changed.emit(); }
  }

  dispose(): void {
    this.disposed = true;
    this.services.sessions.runningChanged.disconnect(this.sync, this);
    this.services.kernels.runningChanged.disconnect(this.sync, this);
    for (const watch of this.watches.values()) { this.cancelProbe(watch); watch.kernel.dispose(); }
    this.watches.clear();
    Signal.clearData(this);
  }
}
