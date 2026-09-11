import { Signal } from '@lumino/signaling';
import { DdbObj, urgent } from 'dolphindb/browser.js';
import { request, type Profile, type SessionTicket } from '../api';
import type { ConnectionModel } from '../model';
import type { DdbConnection } from '../upstream/connection';
import { displayValue, executeInSession, loadDatabases, loadVariables, openSdk, previewConnection, tablePreview, tableSchema, variablePreview, type DatabaseEntry, type DisplayValue, type VariableEntry } from './runtime';
import { OutputFolding } from './folding';
import { snapshotTicket } from '../data/registry';
import { remotePage } from '../data/sdk';
import type { BrowseRequest, DataPage, DataTarget } from '../data/types';

export interface SessionInfo {
  id: string; path: string; profile: Profile; locked: boolean; attached: boolean;
  state: 'starting' | 'idle' | 'busy' | 'disconnected'; executionCount: number;
}
interface SavedRun {
  id: number; code: string; line: string; started: string; finished: string | null;
  status: string; frames: string[]; truncated: boolean;
}
export interface OutputEntry {
  id: string; label: string; status: string; prints: string[]; value?: DisplayValue; error?: string; elapsed?: number;
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/([?&]token=)[^&\s]+/g, '$1[redacted]');

function restoreRun(run: SavedRun, sessionId: string, path: string): OutputEntry {
  const output: OutputEntry = { id: `${sessionId}:${run.id}`, label: `执行 ${run.id} · 第 ${run.line} 行`, status: run.status, prints: [] };
  for (const frame of run.frames) {
    try {
      const data = Uint8Array.from(atob(frame), c => c.charCodeAt(0));
      const decoder = new TextDecoder();
      if (decoder.decode(data.subarray(0, 4)) === 'MSG\n') { output.prints.push(decoder.decode(data.subarray(4, -1))); continue; }
      const first = data.indexOf(10), second = data.indexOf(10, first + 1);
      const status = decoder.decode(data.subarray(first + 1, second));
      if (status !== 'OK') { output.error = status; }
      else { const obj = DdbObj.parse(data.subarray(second + 1), decoder.decode(data.subarray(0, first)).split(' ')[2] !== '0'); output.value = { ...displayValue(obj), browser: snapshotTicket(obj, `${path.split('/').pop()} · ${output.label}`) }; }
    } catch { output.error = '此结果无法恢复，请查看后续输出。'; }
  }
  if (run.truncated) { output.prints.push('历史输出达到保存上限，部分内容已省略。'); }
  if (run.finished) { output.elapsed = Date.parse(run.finished) - Date.parse(run.started); }
  return output;
}

export class DosModel {
  readonly changed = new Signal<this, void>(this);
  readonly previewReady = new Signal<this, { title: string; value: DisplayValue }>(this);
  readonly folding = new OutputFolding();
  session: SessionInfo | null = null;
  connection: DdbConnection | null = null;
  private preview: DdbConnection | null = null;
  private previewState: ConnectionModel['state'] | null = null;
  private generation = 0;
  private browseCache = new Map<string, DdbObj>();
  private browseVersion = '';
  private selectedId: string | null = null;
  private followsDefault = true;
  private initializing: Promise<void> | null = null;
  private attaching: Promise<void> | null = null;
  private views = 0;
  private loadedHistory = -1;
  private historyConfiguration = '';
  busy = false;
  private debugActive = false;
  private debugProfile: Profile | undefined;
  loading = false;
  notice: string | null = null;
  databaseError: string | null = null;
  variablesError: string | null = null;
  pathError = false;
  databases: DatabaseEntry[] = [];
  variables: VariableEntry[] = [];
  outputs: OutputEntry[] = [];

  constructor(public path: string, readonly manager: DosManager) {}

  get debugging(): boolean { return this.debugActive; }
  set debugging(value: boolean) {
    if (value && !this.debugActive) { this.debugProfile = this.profile ? { ...this.profile } : undefined; }
    this.debugActive = value;
    if (!value) { this.debugProfile = undefined; }
  }

  get locked(): boolean { return Boolean(this.session?.locked); }
  get profile(): Profile | undefined {
    return this.debugProfile ?? this.session?.profile ?? (this.followsDefault ? this.manager.defaultProfile
      : this.manager.connections.state.connections.find(p => p.id === this.selectedId));
  }
  get executing(): boolean { return this.busy || this.session?.state === 'busy'; }
  get panelLoading(): boolean { return this.loading; }
  get selection(): string { return this.followsDefault && !this.session && !this.debugging ? '' : this.profile?.id ?? ''; }
  get status(): string {
    return this.debugging ? '调试中' : this.executing ? '运行中' : this.session?.state === 'disconnected' ? '已断开'
      : this.loading ? '连接中' : this.locked ? '会话就绪' : '尚未运行';
  }
  get sdk(): DdbConnection | null { return this.connection ?? this.preview; }
  browserIdentity(): string { return `${this.profile?.id}:${this.session?.id ?? `preview:${this.generation}`}`; }

  async browse(target: DataTarget, request: BrowseRequest): Promise<DataPage> {
    const connection = this.sdk, generation = this.generation, execution = this.session?.executionCount, identity = this.browserIdentity();
    if (!connection || this.executing || this.loading) { throw new Error('会话暂不可用，请等待执行完成。'); }
    const version = `${generation}:${execution}:${request.revision ?? 0}`;
    if (version !== this.browseVersion) { this.browseVersion = version; this.browseCache.clear(); }
    const page = await remotePage(connection, target, request, this.browseCache);
    if (connection !== this.sdk || generation !== this.generation || execution !== this.session?.executionCount || identity !== this.browserIdentity() || this.executing) { throw new Error('会话或数据已变化，请刷新。'); }
    return page;
  }

  async previewVariable(name: string): Promise<DisplayValue> {
    const connection = this.connection, sessionId = this.session?.id, executionCount = this.session?.executionCount, variables = this.variables;
    if (!this.locked || this.executing || !connection || !variables.some(variable => variable.name === name)) {
      throw new Error('变量预览暂不可用。');
    }
    const value = await variablePreview(connection.ddb, name, this.manager.connections.preferences.value.advanced.variablePreviewBytes);
    if (this.connection !== connection || this.session?.id !== sessionId || this.session?.executionCount !== executionCount || this.variables !== variables || this.executing) {
      throw new Error('DDB 会话已变化。');
    }
    return value;
  }

  async previewTableSchema(database: string, table: string): Promise<DisplayValue> {
    const connection = this.sdk, generation = this.generation, executionCount = this.session?.executionCount, databases = this.databases;
    if (!connection || this.executing || this.loading) { throw new Error('表结构暂不可用。'); }
    const value = await tableSchema(connection, database, table);
    if (connection !== this.sdk || generation !== this.generation || executionCount !== this.session?.executionCount
      || databases !== this.databases || this.executing) { throw new Error('DDB 会话已变化。'); }
    return value;
  }

  open(): void {
    this.views++;
    void this.initialize();
  }
  closeView(): void {
    this.views = Math.max(0, this.views - 1);
    if (!this.views && !this.session) {
      this.generation++;
      this.browseCache.clear();
      this.preview?.disconnect();
      this.preview = null;
      this.loading = false;
      this.initializing = null;
      this.changed.emit();
    }
  }
  initialize(): Promise<void> {
    return this.initializing ??= (async () => {
      await this.manager.ready;
      if (!this.views) { return; }
      const existing = this.manager.sessions.find(s => s.path === this.path);
      if (existing) { this.session = existing; await this.restore(); }
      else { await this.syncConnection(); }
    })().catch(error => { this.notice = errorText(error); this.changed.emit(); });
  }

  async syncConnection(): Promise<void> {
    if (this.session || this.busy || this.debugging) { return; }
    const id = this.followsDefault ? this.manager.defaultProfile?.id ?? null : this.selectedId;
    // A saved snapshot also covers password-only edits, which are deliberately
    // absent from public profiles. Settings/notice signals keep the same snapshot.
    if (id !== this.selectedId || this.previewState !== this.manager.connections.state || (!this.preview && !this.loading)) {
      this.selectedId = id;
      await this.loadPreview();
    }
  }

  async select(id: string): Promise<void> {
    if (this.debugging) { throw new Error('调试期间不能切换连接，请先停止调试。'); }
    if (this.locked || this.busy || this.session) { throw new Error('首次运行后连接已固定，请先关闭会话。'); }
    this.selectedId = id || null;
    this.followsDefault = !id;
    await this.loadPreview();
  }

  async closeSession(): Promise<void> {
    if (!this.session || this.executing || this.loading || this.debugging) { return; }
    try { await this.manager.shutdown(this.session.id); }
    catch (error) { this.notice = errorText(error); this.changed.emit(); }
  }

  async loadPreview(): Promise<void> {
    // A cached document can follow default changes without holding a socket.
    if (!this.views || this.session || this.busy || this.debugging) { return; }
    this.previewState = this.manager.connections.state;
    const generation = ++this.generation;
    this.browseCache.clear();
    this.preview?.disconnect();
    this.preview = null;
    this.databases = [];
    this.variables = [];
    this.databaseError = null;
    this.notice = null;
    const profile = this.profile;
    if (!profile) { this.loading = false; this.changed.emit(); return; }
    this.loading = true;
    this.changed.emit();
    let preview: DdbConnection | null = null;
    try {
      preview = await previewConnection(profile.id, profile.name);
      if (generation !== this.generation) { preview.disconnect(); return; }
      // Track the socket while metadata is pending so closing the view releases it.
      this.preview = preview;
      const databases = await loadDatabases(preview);
      if (generation !== this.generation) { preview.disconnect(); return; }
      this.databases = databases;
    } catch (error) {
      preview?.disconnect();
      if (generation === this.generation) { this.preview = null; this.databaseError = errorText(error); }
    } finally {
      if (generation === this.generation) { this.loading = false; this.changed.emit(); }
    }
  }

  async restore(force = false): Promise<void> {
    if (this.attaching) { await this.attaching; return; }
    const session = this.session;
    if (!session || (this.busy && !force)) { return; }
    if (session.state === 'busy') { this.changed.emit(); return; }
    this.attaching = (async () => {
      this.loading = true;
      this.changed.emit();
      await this.syncHistorySettings();
      const detail = await request<SessionInfo & { history: SavedRun[] }>(`dos-sessions/${session.id}`);
      this.session = detail;
      if (this.loadedHistory !== detail.executionCount) {
        this.outputs = detail.history.map(run => restoreRun(run, session.id, this.path));
        this.loadedHistory = detail.executionCount;
      }
      if (detail.state === 'disconnected') { return; }
      if (!this.connection?.ddb.connected) {
        this.connection = await openSdk(await request<SessionTicket>(`dos-sessions/${session.id}/attach`, 'POST'), detail.profile.name);
        await this.refreshMetadata();
      }
    })().catch(error => { this.notice = errorText(error); }).finally(() => {
      this.loading = false; this.attaching = null; this.changed.emit();
    });
    await this.attaching;
  }

  private async ensureSession(): Promise<void> {
    if (this.session) {
      await this.restore(true);
      if (!this.connection?.ddb.connected) { throw new Error('会话不可用，请从正在运行面板关闭旧会话后重试。'); }
      return;
    }
    const profile = this.profile;
    if (!profile) { throw new Error('请先在连接侧栏配置并选择默认连接。'); }
    this.generation++;
    this.preview?.disconnect();
    this.preview = null;
    const history = this.historySettings();
    this.session = await request<SessionInfo>('dos-sessions', 'POST', { path: this.path, connectionId: profile.id, history });
    this.historyConfiguration = `${this.session.id}:${JSON.stringify(history)}`;
    try {
      const ticket = await request<SessionTicket>(`dos-sessions/${this.session.id}/attach`, 'POST');
      this.connection = await openSdk(ticket, profile.name);
    } catch (error) {
      if (!this.session.locked) { await request(`dos-sessions/${this.session.id}`, 'DELETE'); this.session = null; }
      throw error;
    }
  }

  async run(code: string, line = 0): Promise<boolean> {
    if (this.debugging) { this.notice = '此文件正在调试，请先停止调试。'; this.changed.emit(); return false; }
    if (!code.trim()) { return true; }
    if (this.executing || this.pathError) { this.notice = '此文件正在运行或路径尚未同步，请稍后重试。'; this.changed.emit(); return false; }
    await this.initialize();
    if (this.executing) { return false; }
    this.busy = true;
    this.notice = null;
    this.changed.emit();
    let output: OutputEntry | null = null;
    let success = false;
    const started = performance.now();
    try {
      await this.ensureSession();
      const session = this.session!;
      session.locked = true;
      session.state = 'busy';
      output = { id: `${session.id}:${session.executionCount + 1}`, label: `执行 ${session.executionCount + 1} · 第 ${line + 1} 行`, status: 'running', prints: [] };
      const historyEntries = this.manager.connections.preferences.value.advanced.historyEntries;
      this.outputs = [...this.outputs.slice(Math.max(0, this.outputs.length - historyEntries + 1)), output];
      this.changed.emit();
      const result = await executeInSession(this.connection!, code, line, text => {
        if (output!.prints.join('\n').length < 200_000) { output!.prints.push(text); }
        this.changed.emit();
      });
      output.value = { ...displayValue(result), browser: snapshotTicket(result, `${this.path.split('/').pop()} · ${output.label}`) };
      output.status = 'ok';
      success = true;
    } catch (error) {
      const message = errorText(error);
      if (output) { output.error = message; output.status = 'error'; }
      else { this.notice = message; }
    } finally {
      if (output) { output.elapsed = performance.now() - started; }
      if (this.session) {
        const detail = await request<SessionInfo>(`dos-sessions/${this.session.id}`).catch(() => null);
        if (detail) { this.session = detail; this.loadedHistory = detail.executionCount; }
        await this.refreshMetadata();
      }
      this.busy = false;
      this.loading = false;
      if (this.notice?.startsWith('已发送中断请求')) { this.notice = null; }
      if (!this.session && this.views) { void this.syncConnection(); }
      this.changed.emit();
      await this.manager.refresh();
    }
    return success;
  }

  async refreshMetadata(): Promise<void> {
    if (!this.connection?.ddb.connected) { return; }
    const connection = this.connection;
    const results = await Promise.allSettled([loadDatabases(connection), loadVariables(connection.ddb)]);
    if (connection !== this.connection) { return; }
    if (results[0].status === 'fulfilled') { this.databases = results[0].value; this.databaseError = null; }
    else { this.databaseError = errorText(results[0].reason); }
    if (results[1].status === 'fulfilled') { this.variables = results[1].value; this.variablesError = null; }
    else { this.variablesError = errorText(results[1].reason); }
    this.changed.emit();
  }

  async refreshPanels(): Promise<void> {
    if (this.executing || this.loading) { return; }
    if (this.locked) { await this.refreshMetadata(); }
    else { await this.loadPreview(); }
  }

  async inspectTable(database: string, table: string): Promise<void> {
    if (this.executing || !this.sdk) { return; }
    const connection = this.sdk;
    try {
      const rows = this.manager.connections.preferences.value.preview.tableRows;
      const value = await tablePreview(connection, database, table, rows);
      if (connection !== this.sdk) { return; }
      this.previewReady.emit({ title: `${table} · 前 ${rows} 行`, value });
    } catch (error) { this.notice = errorText(error); }
    this.changed.emit();
  }

  async interrupt(): Promise<void> {
    if (!this.session || !this.executing) { return; }
    let control: DdbConnection | null = null;
    try {
      const ticket = await request<SessionTicket>(`dos-sessions/${this.session.id}/control`, 'POST');
      control = await openSdk(ticket, this.session.profile.name, false);
      const sid = this.connection?.ddb.sid;
      if (!sid || !/^\d+$/.test(sid)) { throw new Error('等待当前页面恢复会话后再中断，或直接关闭会话。'); }
      // Same getConsoleJobs/cancelConsoleJob flow used by the upstream SDK's cancel().
      await control.ddb.eval(`jobs = exec rootJobId from getConsoleJobs() where sessionId = ${sid}\nif (size(jobs))\n    cancelConsoleJob(jobs)\n`, urgent);
      if (this.executing) { this.notice = '已发送中断请求，正在等待服务器停止执行。'; }
    } catch (error) { this.notice = errorText(error); }
    finally { control?.disconnect(); this.changed.emit(); }
  }

  async rename(path: string): Promise<void> {
    const previous = this.path;
    try {
      if (this.session) { this.session = await request<SessionInfo>(`dos-sessions/${this.session.id}`, 'PATCH', { path }); }
      this.path = path;
      this.pathError = false;
      this.manager.documents.delete(previous);
      this.manager.documents.set(path, this);
    } catch (error) { this.pathError = true; this.notice = errorText(error); }
    this.changed.emit();
  }

  private historySettings() {
    const { historyEntries, historyMegabytes } = this.manager.connections.preferences.value.advanced;
    return { historyEntries, historyMegabytes };
  }
  private async syncHistorySettings(): Promise<void> {
    if (!this.session) { return; }
    const session = this.session, history = this.historySettings(), key = `${session.id}:${JSON.stringify(history)}`;
    if (this.historyConfiguration === key) { return; }
    await request(`dos-sessions/${session.id}`, 'PATCH', { path: this.path, history });
    if (this.session?.id === session.id) {
      this.historyConfiguration = key;
      // Retain displayed objects and their MIME view state when only the
      // history budget changes; replay is needed only for unseen executions.
      this.outputs = this.outputs.slice(-history.historyEntries);
    }
  }

  reset(): void {
    this.generation++;
    this.browseCache.clear();
    this.connection?.disconnect();
    this.preview?.disconnect();
    this.connection = this.preview = null;
    this.session = null;
    this.initializing = null;
    this.followsDefault = true;
    this.selectedId = this.manager.defaultProfile?.id ?? null;
    this.variables = [];
    this.databases = [];
    this.databaseError = this.variablesError = null;
    this.loadedHistory = -1;
    this.notice = '会话已关闭；下次运行将创建新会话。';
    this.changed.emit();
    if (this.views && !this.busy) { void this.loadPreview(); }
  }
}

export class DosManager {
  readonly changed = new Signal<this, void>(this);
  readonly documents = new Map<string, DosModel>();
  sessions: SessionInfo[] = [];
  readonly ready: Promise<void>;
  private refreshing: Promise<void> | null = null;

  constructor(readonly connections: ConnectionModel) {
    this.ready = (async () => { await connections.refresh(); await this.refresh(); })();
    connections.changed.connect(() => {
      for (const model of this.documents.values()) { void model.syncConnection(); model.changed.emit(); }
    });
    window.setInterval(() => { void this.refresh(); }, 2500);
  }

  document(path: string): DosModel {
    let model = this.documents.get(path);
    if (!model) { model = new DosModel(path, this); this.documents.set(path, model); }
    return model;
  }

  get defaultProfile(): Profile | undefined {
    const state = this.connections.state;
    return state.connections.find(p => p.id === state.activeId) ?? state.connections[0];
  }

  /** Resolve the execution target for batch confirmation without opening a document. */
  profileFor(path: string): Profile | undefined {
    const session = this.sessions.find(s => s.path === path);
    if (session) { return session.profile; }
    const model = this.documents.get(path);
    return model ? model.profile : this.defaultProfile;
  }

  refresh(): Promise<void> {
    return this.refreshing ??= (async () => {
      this.sessions = (await request<{ sessions: SessionInfo[] }>('dos-sessions')).sessions;
      for (const model of this.documents.values()) {
        if (!model.session || model.busy) { continue; }
        const info = this.sessions.find(s => s.id === model.session!.id);
        if (!info) { model.reset(); }
        else {
          const changed = model.session.state !== info.state;
          model.session = info;
          if (!model.connection?.ddb.connected && !info.attached && info.state === 'idle') { void model.restore(); }
          if (changed) { model.changed.emit(); }
        }
      }
      this.changed.emit();
    })().catch(() => { /* Keep the last state while Jupyter is temporarily unreachable. */ })
      .finally(() => { this.refreshing = null; });
  }

  async shutdown(id: string): Promise<void> {
    await request(`dos-sessions/${id}`, 'DELETE');
    for (const model of this.documents.values()) { if (model.session?.id === id) { model.reset(); } }
    await this.refresh();
  }
}
