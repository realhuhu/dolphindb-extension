import { Signal } from '@lumino/signaling';
import { DdbObj } from 'dolphindb/browser.js';
import { DebugRemote, type DebugMessage, type DebugVariable } from './remote';
import type { Profile, SessionTicket } from '../api';

export type DebugState = 'idle' | 'starting' | 'running' | 'paused' | 'stopping' | 'ended';
export interface DebugFrame { stackFrameId: number; line: number; column?: number; name?: string; moduleName?: string; }
export interface DebugSource { path: string; module: string; content?: string; }
export interface Breakpoint { line: number; verified: boolean; }
export interface DebugHost {
  ticket(): Promise<SessionTicket>;
  url(path: string): string;
  source(): string;
  locked(active: boolean): void;
}

/** One DOS file, one independent debug connection. All lines here are zero-based. */
export class DosDebugSession {
  readonly changed = new Signal<this, void>(this);
  readonly id = crypto.randomUUID();
  state: DebugState = 'idle';
  profile: Profile | undefined;
  frames: DebugFrame[] = [];
  frame: DebugFrame | null = null;
  variables: DebugVariable[] = [];
  output = '';
  error = '';
  reason = '';
  exceptions = false;
  readonly sources = new Map<string, DebugSource>();
  readonly breaks = new Map<string, Breakpoint[]>();
  private remote: DebugRemote | null = null;
  private epoch = 0;
  private frameEpoch = 0;
  private configurationVersion = 0;
  private controls = false;
  private stopping: Promise<void> | null = null;
  private variableCache = new Map<string, Promise<DebugVariable>>();
  constructor(public path: string, readonly host: DebugHost,
    private createRemote = (url: string, timeout: number, event: (m: DebugMessage) => void, closed: (e: Error) => void) => new DebugRemote(url, timeout, event, closed)) {
    this.sources.set(path, { path, module: '' });
  }
  get active(): boolean { return this.state !== 'idle' && this.state !== 'ended'; }
  get pending(): boolean { return this.controls || this.state === 'starting' || this.state === 'stopping'; }
  get paused(): boolean { return this.state === 'paused'; }
  private emit(): void { this.changed.emit(); }
  report(error: unknown): void { this.error = error instanceof Error ? error.message : String(error); this.emit(); }
  private clearFrame(): void { ++this.frameEpoch; this.frames = []; this.frame = null; this.variables = []; this.variableCache.clear(); }

  async start(profile: Profile): Promise<void> {
    if (this.active) { return; }
    const epoch = ++this.epoch;
    this.profile = { ...profile }; this.state = 'starting'; this.output = ''; this.error = ''; this.reason = '';
    this.clearFrame(); this.host.locked(true);
    const content = this.host.source().replace(/\r\n/g, '\n');
    this.sources.clear(); this.sources.set(this.path, { path: this.path, module: '', content });
    this.emit();
    try {
      const ticket = await this.host.ticket();
      if (epoch !== this.epoch) { ticket.password = ''; return; }
      const remote = this.remote = this.createRemote(this.host.url(ticket.path), Math.max(1000, ticket.timeout * 1000),
        message => { if (epoch === this.epoch) { this.onEvent(message); } },
        error => { if (epoch === this.epoch) { this.finish('连接已断开'); this.report(error); } });
      const password = ticket.password; ticket.password = '';
      await remote.connect(ticket.username, password);
      const parsed = await remote.call<{ modules?: Record<string, string> }>('parseScriptWithDebug', [content]);
      if (epoch !== this.epoch) { return; }
      for (const module of Object.keys(parsed?.modules ?? {})) {
        const path = `ddb-debug/${this.id}/${module.replaceAll('::', '/')}.dos`;
        this.sources.set(path, { path, module });
      }
      for (const path of this.breaks.keys()) { if (!this.sources.has(path)) { this.breaks.delete(path); } }
      let configuredVersion: number;
      do {
        configuredVersion = this.configurationVersion;
        for (const path of this.sources.keys()) {
          await this.sendBreaks(path);
          if (epoch !== this.epoch) { return; }
        }
        await remote.call('setAllExceptionBreak', [this.exceptions]);
        if (epoch !== this.epoch) { return; }
        // Gutter edits remain available during connection/setup. Do not start
        // executing until all changes made while waiting for RPCs are applied.
      } while (configuredVersion !== this.configurationVersion);
      this.state = 'running'; this.emit();
      await remote.call('runScriptWithDebug');
    } catch (error) { if (epoch === this.epoch) { this.finish('启动失败'); this.report(error); } }
  }

  stop(): Promise<void> {
    return this.stopping ??= this.stopRemote().finally(() => { this.stopping = null; });
  }
  private async stopRemote(): Promise<void> {
    if (!this.active) { return; }
    if (this.state === 'starting') { this.finish('已停止'); return; }
    const remote = this.remote, epoch = this.epoch;
    this.state = 'stopping'; this.clearFrame(); this.emit();
    try { await remote?.call('stopRun'); }
    catch (error) { if (epoch === this.epoch && this.active) { this.report(error); } }
    finally { if (epoch === this.epoch) { this.finish('已停止'); } }
  }

  private finish(reason = '已结束'): void {
    ++this.epoch;
    this.remote?.close(); this.remote = null; this.controls = false;
    this.state = 'ended'; this.reason = reason; this.clearFrame(); this.host.locked(false);
    for (const points of this.breaks.values()) { for (const point of points) { point.verified = false; } }
    this.emit();
  }

  async control(func: 'continueRun' | 'pauseRun' | 'stepOver' | 'stepInto' | 'stepOut'): Promise<void> {
    if (this.pending || !this.remote || (func === 'pauseRun' ? this.state !== 'running' : !this.paused)) { return; }
    const epoch = this.epoch;
    this.controls = true;
    if (func !== 'pauseRun') { this.state = 'running'; this.clearFrame(); }
    this.emit();
    try {
      await this.remote.call(func);
      // Some supported servers acknowledge pauseRun without emitting STEP.
      // Its successful response is the pause acknowledgement; then request the stack.
      if (func === 'pauseRun' && epoch === this.epoch && this.state === 'running') {
        this.state = 'paused'; this.reason = '手动暂停'; this.clearFrame(); this.emit();
        const version = this.frameEpoch;
        setTimeout(() => { if (epoch === this.epoch && version === this.frameEpoch) { void this.loadStack(undefined, version); } }, 0);
      }
    }
    catch (error) { if (epoch === this.epoch) { this.finish(); this.report(error); } }
    finally { if (epoch === this.epoch) { this.controls = false; this.emit(); } }
  }

  async setExceptions(value: boolean): Promise<void> {
    this.exceptions = value; ++this.configurationVersion; this.emit();
    if (this.remote && this.active && this.state !== 'starting') {
      try { await this.remote.call('setAllExceptionBreak', [value]); } catch (error) { this.report(error); }
    }
  }
  async setBreakpoints(path: string, lines: number[]): Promise<void> {
    this.breaks.set(path, [...new Set(lines)].filter(line => Number.isInteger(line) && line >= 0).sort((a, b) => a - b).map(line => ({ line, verified: false })));
    ++this.configurationVersion;
    this.emit();
    if (this.remote && this.active && this.state !== 'starting') {
      try { await this.sendBreaks(path); } catch (error) { this.report(error); }
    }
  }
  private async sendBreaks(path: string): Promise<void> {
    const source = this.sources.get(path), points = this.breaks.get(path) ?? [], epoch = this.epoch;
    if (!source || !this.remote) { return; }
    const result = await this.remote.call<[string | null, number[]]>('setBreaks', [source.module, points.map(p => p.line)]);
    if (epoch !== this.epoch || this.breaks.get(path) !== points) { return; }
    for (const point of points) { point.verified = result[1].includes(point.line); }
    this.emit();
  }
  sourcePath(module?: string): string { return [...this.sources.values()].find(source => source.module === (module ?? ''))?.path ?? this.path; }
  async source(path: string): Promise<string> {
    const source = this.sources.get(path);
    if (!source) { return ''; }
    if (source.content !== undefined) { return source.content; }
    if (!this.remote) { return ''; }
    const epoch = this.epoch;
    const content = await this.remote.call<string>('sourceRequest', source.module);
    if (epoch !== this.epoch) { return ''; }
    source.content = content; return content;
  }

  async selectFrame(frame: DebugFrame): Promise<void> {
    if (!this.paused || !this.remote) { return; }
    this.frame = frame; this.variables = []; this.variableCache.clear();
    const version = ++this.frameEpoch; this.emit();
    if (frame.stackFrameId < 0) { return; }
    try {
      const variables = await this.remote.call<DebugVariable[]>('getStackVariables', [frame.stackFrameId]);
      if (version === this.frameEpoch && this.paused) { this.variables = variables; this.emit(); }
    } catch (error) { if (version === this.frameEpoch) { this.report(error); } }
  }
  async variable(variable: DebugVariable): Promise<DebugVariable> {
    if (!this.paused || !this.frame || !this.remote || !this.variables.includes(variable)) { throw new Error('变量所属的调试栈帧已变化。'); }
    if (variable.ddbValue || variable.data !== undefined || variable.offset === -1) { return variable; }
    const frame = this.frame.stackFrameId, version = this.frameEpoch, key = `${frame}:${variable.vid}:${variable.name}`;
    let promise = this.variableCache.get(key);
    if (!promise) {
      promise = this.remote.call<DebugVariable>('getVariable', [frame, variable.vid ?? 0, variable.name]).then(value => {
        if (version !== this.frameEpoch || !this.paused) { throw new Error('变量所属的调试栈帧已变化。'); }
        return value;
      });
      this.variableCache.set(key, promise);
      void promise.catch(() => { this.variableCache.delete(key); });
    }
    return promise;
  }
  async value(variable: DebugVariable): Promise<DdbObj | undefined> { return (await this.variable(variable)).ddbValue; }

  private onEvent(message: DebugMessage): void {
    if (message.event === 'OUTPUT') { this.output = (this.output + String(message.data ?? '') + '\n').slice(-100_000); this.emit(); return; }
    if (message.event === 'END') { this.finish(message.data?.status === 'STOPPED' ? '已停止' : '执行完成'); return; }
    if (message.event === 'SYNTAX') { this.finish('语法错误'); this.report(message.message); return; }
    if (['BREAKPOINT', 'STEP', 'ERROR'].includes(message.event ?? '')) {
      if (this.state === 'stopping') { return; }
      this.state = 'paused'; this.clearFrame();
      this.reason = message.event === 'BREAKPOINT' ? '命中断点' : message.event === 'STEP' ? '单步暂停' : '异常暂停';
      if (message.event === 'ERROR') { this.error = message.message; }
      this.emit();
      const epoch = this.epoch, version = this.frameEpoch;
      // The server reports PAUSED before the stack is ready (upstream VSCODE-58).
      setTimeout(() => { if (epoch === this.epoch && version === this.frameEpoch) { void this.loadStack(message.data, version); } }, 0);
    }
  }
  private async loadStack(location: { line?: number; moduleName?: string } | undefined, version: number): Promise<void> {
    try {
      const frames = await this.remote!.call<DebugFrame[]>('stackTrace');
      if (version !== this.frameEpoch || !this.paused) { return; }
      this.frames = [...frames].reverse();
      if (!this.frames.length && location?.line !== undefined) { this.frames = [{ stackFrameId: -1, line: location.line, moduleName: location.moduleName }]; }
      if (this.frames[0]) { await this.selectFrame(this.frames[0]); }
      else { this.emit(); }
    } catch (error) { if (version === this.frameEpoch) { this.report(error); } }
  }
}
