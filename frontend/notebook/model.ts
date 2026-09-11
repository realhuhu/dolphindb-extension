import type { ISessionContext } from '@jupyterlab/apputils';
import type { Kernel, KernelMessage } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';
import { request, type Profile } from '../api';
import type { ConnectionModel } from '../model';
import type { DatabaseEntry, VariableEntry, DisplayValue } from '../dos/runtime';

export const COMM_TARGET = 'dolphindb-extension:notebook';
export const LOAD_CODE = "from dolphindb_extension.magics import load_notebook_extension as _ddb_load\n_ddb_load(get_ipython())\ndel _ddb_load";
type KernelProfile = Pick<Profile, 'id' | 'name' | 'host' | 'port'>;
type State = { kind: 'state'; profile: KernelProfile | null; locked: boolean; busy: boolean; configuring: boolean; requestedId: string | null; error: string | null };

/** A comm observes the Python kernel; disposing a notebook view keeps its DDB session. */
export class NotebookConnection {
  readonly changed = new Signal<this, void>(this);
  readonly previewReady = new Signal<this, { title: string; value: DisplayValue }>(this);
  profile: KernelProfile | null = null;
  locked = false;
  busy = false;
  loading = false;
  phase: 'waiting' | 'loading' | 'ready' | 'unsupported' | 'error' = 'waiting';
  notice: string | null = null;
  followsDefault = true;
  languageRevision = 0;
  databases: DatabaseEntry[] = [];
  variables: VariableEntry[] = [];
  databaseError: string | null = null;
  variablesError: string | null = null;
  panelLoading = false;
  private panelActive = false;
  private panelDirty = true;
  private panelGeneration = 0;
  private panelRequest: Promise<void> | null = null;
  private selectedId: string | null = null;
  private comm: Kernel.IComm | null = null;
  private generation = 0;
  private configuration = 0;
  private initializing: Promise<void> | null = null;
  private disposed = false;
  private lastSnapshot;
  private metadataRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(readonly context: ISessionContext, readonly connections: ConnectionModel) {
    this.lastSnapshot = connections.state;
    connections.changed.connect(this.connectionsChanged, this);
    context.kernelChanged.connect(this.kernelChanged, this);
    context.statusChanged.connect(this.statusChanged, this);
    context.connectionStatusChanged.connect(this.connectionStatusChanged, this);
    void context.ready.then(() => this.initialize());
  }

  get defaultProfile(): Profile | undefined {
    return this.connections.state.connections.find(p => p.id === this.connections.state.activeId)
      ?? this.connections.state.connections[0];
  }
  get selection(): string { return this.followsDefault && !this.locked ? '' : this.profile?.id ?? this.selectedId ?? ''; }
  get executing(): boolean { return this.busy || this.context.session?.kernel?.status === 'busy'; }
  get status(): string {
    return this.notice ?? (this.phase === 'unsupported' ? '需要 Python 内核' : this.phase === 'waiting' ? '等待 Python 内核'
      : this.phase === 'loading' || this.loading ? '正在准备 DDB' : this.busy ? '运行中' : this.locked ? '会话就绪' : '尚未运行');
  }

  private connectionsChanged(): void {
    const changed = this.lastSnapshot !== this.connections.state;
    this.lastSnapshot = this.connections.state;
    if (changed && this.phase === 'ready' && !this.locked && !this.busy) {
      void this.select(this.followsDefault ? '' : this.selectedId ?? '');
    }
    this.changed.emit();
  }

  private reset(): void {
    this.clearPanels();
    this.languageRevision++;
    this.rejectMetadata();
    this.generation++;
    this.configuration++;
    this.initializing = null;
    const comm = this.comm;
    this.comm = null;
    if (comm && !comm.isDisposed) { comm.close(); comm.dispose(); }
    this.profile = null;
    this.locked = this.busy = this.loading = false;
    this.phase = 'waiting';
    this.notice = null;
    this.changed.emit();
  }

  private kernelChanged(): void { this.reset(); void this.initialize(); }
  private statusChanged(_sender: ISessionContext, status: Kernel.Status): void {
    if (status === 'restarting' || status === 'autorestarting' || status === 'dead') { this.reset(); }
    else if (status === 'idle') {
      if (this.phase === 'waiting') { void this.initialize(); }
      void this.updatePanels();
    }
    this.changed.emit();
  }
  private connectionStatusChanged(_sender: ISessionContext, status: Kernel.ConnectionStatus): void {
    // A reconnect may lose a reply without changing the DDB session state.
    this.panelGeneration++;
    this.panelDirty = true;
    this.languageRevision++;
    if (status === 'connected' && this.comm) { this.comm.send({ kind: 'status' }); }
    else { this.rejectMetadata(); }
  }

  initialize(): Promise<void> {
    if (this.disposed || this.comm) { return Promise.resolve(); }
    if (this.initializing) { return this.initializing; }
    const pending = this.attach().finally(() => { if (this.initializing === pending) { this.initializing = null; } });
    return this.initializing = pending;
  }

  private async attach(): Promise<void> {
    const kernel = this.context.session?.kernel;
    if (!kernel || kernel.status === 'restarting' || kernel.status === 'autorestarting') { return; }
    const generation = ++this.generation;
    const current = () => !this.disposed && generation === this.generation && this.context.session?.kernel === kernel;
    this.phase = 'loading'; this.notice = null; this.changed.emit();
    try {
      const info = await kernel.info;
      if (!current()) { return; }
      if (info?.language_info.name.toLowerCase() !== 'python') { this.phase = 'unsupported'; return; }
      const reply = await kernel.requestExecute({ code: LOAD_CODE, silent: true, store_history: false, stop_on_error: false }).done;
      if (!current()) { return; }
      if (reply.content.status !== 'ok') {
        throw new Error('请在当前 Python 内核环境安装 dolphindb-extension[notebook]，然后点击重试。');
      }
      const comm = kernel.createComm(COMM_TARGET);
      // This comm accesses the same SDK session as cell execution. JupyterLab
      // versions with subshell support must keep it on the cell's shell queue.
      if ('commsOverSubshells' in comm) {
        comm.commsOverSubshells = 'disabled' as Kernel.IComm['commsOverSubshells'];
      }
      this.comm = comm;
      let first = true;
      comm.onMsg = message => {
        if (!current() || this.comm !== comm) { return; }
        const response = message.content.data;
        if (response.kind === 'metadata' && typeof response.id === 'string') {
          const pending = this.metadataRequests.get(response.id);
          if (pending) {
            if (response.error) { pending.reject(new Error(String(response.error))); }
            else { pending.resolve(response.result); }
          }
          return;
        }
        const data = message.content.data as unknown as State;
        if (data.kind !== 'state') { return; }
        const changed = this.busy && !data.busy || this.profile?.id !== data.profile?.id || this.locked !== data.locked;
        if (changed) { this.languageRevision++; this.panelDirty = true; }
        if (this.profile?.id !== data.profile?.id || this.locked && !data.locked) { this.clearPanels(); }
        this.profile = data.profile;
        this.locked = data.locked;
        this.busy = data.busy;
        this.notice = data.error;
        this.phase = 'ready';
        this.loading = data.configuring;
        const requestedId = ((data.configuring && data.profile) || data.error)
          ? data.requestedId ?? ''
          : data.requestedId ?? (this.followsDefault ? '' : this.selectedId ?? '');
        if ((first && data.profile) || data.locked) {
          this.followsDefault = false;
          this.selectedId = data.profile?.id ?? null;
        }
        const configure = first && !data.locked && (!data.profile || data.configuring || Boolean(data.error));
        first = false;
        this.changed.emit();
        if (configure) { void this.select(requestedId); }
        else if (!data.busy && !data.configuring) { void this.updatePanels(); }
      };
      comm.onClose = () => {
        if (!current() || this.comm !== comm) { return; }
        this.comm = null;
        this.clearPanels();
        this.rejectMetadata();
        this.phase = 'error';
        this.notice = 'DDB 扩展已卸载或连接已断开，请点击重试。';
        this.changed.emit();
      };
      comm.open({});
    } catch (error) {
      if (current()) { this.phase = 'error'; this.notice = error instanceof Error ? error.message : 'DDB 初始化失败，请重试。'; }
    } finally { if (current()) { this.changed.emit(); } }
  }

  async select(id: string): Promise<void> {
    const comm = this.comm;
    if (!comm || this.locked || this.busy || this.disposed) { return; }
    this.clearPanels();
    this.rejectMetadata();
    this.followsDefault = !id;
    this.selectedId = id || null;
    const configuration = ++this.configuration;
    this.loading = true; this.notice = null; this.changed.emit();
    comm.send({ kind: 'prepare', connectionId: id || null });
    let profile: (Profile & { password: string }) | undefined;
    try {
      profile = await request<Profile & { password: string }>('kernel-connection', 'POST', { connectionId: id || undefined });
      if (this.disposed || this.comm !== comm || configuration !== this.configuration || this.locked) { return; }
      // Credentials travel only in the comm, never in cell source, outputs or execute history.
      comm.send({ kind: 'configure', profile: { ...profile } });
    } catch (error) {
      if (!this.disposed && configuration === this.configuration) {
        this.notice = error instanceof Error ? error.message : '无法读取连接，请重试。';
        if (this.comm === comm) { comm.send({ kind: 'configuration-error' }); }
      }
    } finally {
      if (profile) { profile.password = ''; }
      if (configuration === this.configuration) { this.changed.emit(); }
    }
  }

  async readyForExecution(): Promise<void> {
    await this.context.ready;
    // Missing/unsupported DDB is not a reason to reject ordinary kernel code.
    // Retry initialization only when explicitly requested or the kernel changes.
    if (this.phase !== 'error' && this.phase !== 'unsupported') { await this.initialize(); }
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.changed.disconnect(check);
        if (error) { reject(error); } else { resolve(); }
      };
      const check = () => {
        if (this.disposed) { finish(new Error('Notebook 已关闭。')); }
        else if (this.phase === 'unsupported' || this.phase === 'error'
          || (this.phase === 'ready' && !this.loading && (this.profile || this.notice))) { finish(); }
      };
      // A pending configuration still blocks DDB in the kernel's magic itself;
      // an unavailable connection must never stop Python, SQL or other magics.
      const timer = setTimeout(() => finish(), 30_000);
      this.changed.connect(check);
      check();
    });
  }

  closeSession(): void {
    if (!this.executing && !this.loading && this.comm) {
      this.clearPanels(); this.loading = true; this.changed.emit();
      this.comm.send({ kind: 'close' });
    }
  }

  setPanelActive(active: boolean): void {
    this.panelActive = active;
    if (active) { void this.refreshPanels(); }
  }

  private clearPanels(): void {
    this.panelGeneration++;
    this.panelDirty = true;
    this.databases = []; this.variables = [];
    this.databaseError = this.variablesError = null;
    this.panelLoading = false;
  }

  refreshPanels(): Promise<void> { this.panelDirty = true; return this.updatePanels(); }

  private updatePanels(): Promise<void> {
    if (this.panelRequest) { return this.panelRequest; }
    if (!this.panelActive || !this.panelDirty || this.disposed || !this.profile || this.phase !== 'ready'
      || this.loading || this.executing || this.context.session?.kernel?.status !== 'idle') { return Promise.resolve(); }
    this.panelDirty = false; this.panelLoading = true;
    const generation = this.panelGeneration, revision = this.languageRevision;
    const current = () => generation === this.panelGeneration && revision === this.languageRevision && !this.disposed;
    this.changed.emit();
    const pending = (async () => {
      try {
        const data = await this.metadata('workspace', { includeVariables: this.locked ? 'true' : 'false' }) as {
          databases: DatabaseEntry[]; variables: VariableEntry[]; databaseError: string | null; variablesError: string | null;
        };
        if (!current()) { return; }
        this.databases = data.databases;
        this.variables = this.locked ? data.variables : [];
        this.databaseError = data.databaseError; this.variablesError = data.variablesError;
      } catch (error) {
        if (current()) {
          this.databaseError = error instanceof Error ? error.message : '无法读取数据库与变量。';
          this.variablesError = this.locked ? this.databaseError : null;
        }
      } finally {
        this.panelRequest = null;
        this.panelLoading = false; this.changed.emit();
        // A new selection/run may have invalidated this response while it was in flight.
        if (this.panelDirty) { void this.updatePanels(); }
      }
    })();
    this.panelRequest = pending;
    return pending;
  }

  async inspectTable(database: string, table: string): Promise<void> {
    if (this.executing || this.loading) { return; }
    const generation = this.panelGeneration, revision = this.languageRevision;
    try {
      const value = await this.metadata('tablePreview', { database, table }) as DisplayValue;
      if (generation === this.panelGeneration && revision === this.languageRevision && !this.disposed) {
        this.previewReady.emit({ title: `${table} · 前 100 行`, value });
      }
    } catch (error) {
      if (generation === this.panelGeneration && !this.disposed) {
        this.databaseError = error instanceof Error ? error.message : '无法预览表。'; this.changed.emit();
      }
    }
  }

  async previewVariable(name: string): Promise<DisplayValue> {
    const generation = this.panelGeneration, revision = this.languageRevision, variables = this.variables;
    if (!this.locked || !variables.some(variable => variable.name === name)) { throw new Error('变量预览暂不可用。'); }
    const value = await this.metadata('variablePreview', { name }) as DisplayValue;
    if (generation !== this.panelGeneration || revision !== this.languageRevision || this.variables !== variables || this.disposed) {
      throw new Error('DDB 会话已变化。');
    }
    if (!value || (typeof value.text !== 'string' && !(Array.isArray(value.columns) && Array.isArray(value.rows)))) {
      throw new Error('无法读取变量预览。');
    }
    return value;
  }

  async previewTableSchema(database: string, table: string): Promise<DisplayValue> {
    const generation = this.panelGeneration, revision = this.languageRevision, databases = this.databases;
    const value = await this.metadata('tableSchema', { database, table }) as DisplayValue;
    if (generation !== this.panelGeneration || revision !== this.languageRevision || this.databases !== databases || this.disposed) {
      throw new Error('DDB 会话已变化。');
    }
    return value;
  }

  private rejectMetadata(): void {
    for (const pending of this.metadataRequests.values()) {
      pending.reject(new Error('DDB 会话已变化。'));
    }
    this.metadataRequests.clear();
  }

  metadata(operation: string, args: Record<string, string> = {}): Promise<unknown> {
    if (!this.comm || this.phase !== 'ready' || this.loading || this.busy || this.context.session?.kernel?.status !== 'idle') {
      return Promise.reject(new Error('DDB 内核暂不可用。'));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const comm = this.comm!;
      let future: Kernel.IShellFuture | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started = false, finished = false, received = false, settled = false;
      let result: unknown;
      const settle = (error?: Error) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        this.context.statusChanged.disconnect(queuedStatus);
        this.metadataRequests.delete(id);
        future?.dispose();
        if (error) { reject(error); } else { resolve(result); }
      };
      const armTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(() => settle(new Error('DDB 元数据读取超时。')), 4000);
      };
      const queuedStatus = (_sender: ISessionContext, status: Kernel.Status) => {
        if (started || settled) { return; }
        // Run All can queue a cell before this request while status is still idle.
        // Time spent waiting for that cell is not metadata execution time.
        if (status === 'idle') { armTimeout(); } else { clearTimeout(timer); }
      };
      const complete = () => {
        if (finished && received) {
          settle(this.comm === comm ? undefined : new Error('DDB 会话已变化。'));
        }
      };
      this.metadataRequests.set(id, {
        // Do not await idle inside onMsg: doing so blocks subsequent kernel messages.
        resolve: value => { received = true; result = value; complete(); },
        reject: error => settle(error),
      });
      this.context.statusChanged.connect(queuedStatus);
      armTimeout();
      try {
        future = comm.send({ kind: 'metadata', id, operation, arguments: args });
        future.onIOPub = message => {
          if (!settled && message.header.msg_type === 'status'
            && (message as KernelMessage.IStatusMsg).content.execution_state === 'busy') {
            started = true;
            armTimeout();
          }
        };
        // Retain the request until reply AND idle, so restart/disconnect can cancel either wait.
        void future.done.then(() => { finished = true; complete(); }, error => settle(error));
      } catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.connections.changed.disconnect(this.connectionsChanged, this);
    this.context.kernelChanged.disconnect(this.kernelChanged, this);
    this.context.statusChanged.disconnect(this.statusChanged, this);
    this.context.connectionStatusChanged.disconnect(this.connectionStatusChanged, this);
    this.reset();
    Signal.clearData(this);
  }
}
