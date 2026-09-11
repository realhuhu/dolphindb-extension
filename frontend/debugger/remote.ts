import { DdbObj } from 'dolphindb/browser.js';
import { json2ddbdict } from '../upstream/debugger-codec';

/** The official debug subprotocol is independent of the normal API2 session. */
export interface DebugVariable {
  name: string; type: string; form: string; rows?: number; columns?: number;
  bytes?: number; vid?: number; offset?: number; data?: unknown; ddbValue?: DdbObj;
}
export interface DebugMessage { id?: number; event?: string; message: string; data?: any; }

export function parseDebugMessage(buffer: ArrayBuffer): DebugMessage {
  if (buffer.byteLength < 4) { throw new Error('调试服务器返回了不完整的消息。'); }
  const bytes = new Uint8Array(buffer), length = new DataView(buffer).getUint32(0, true);
  let offset = 4 + length;
  if (offset > buffer.byteLength) { throw new Error('调试消息长度无效。'); }
  const message: DebugMessage = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, offset)));
  if (!message || typeof message !== 'object' || typeof message.message !== 'string') { throw new Error('调试消息格式无效。'); }
  for (const item of Array.isArray(message.data) ? message.data : [message.data]) {
    if (!item || item.offset === undefined || item.offset === -1 || item.offset === 0) { continue; }
    if (!Number.isSafeInteger(item.offset) || item.offset < 0 || offset + item.offset > buffer.byteLength) {
      throw new Error('调试变量数据长度无效。');
    }
    item.ddbValue = DdbObj.parse(bytes.subarray(offset, offset + item.offset), true);
    offset += item.offset;
  }
  return message;
}

/** Serial requests mirror upstream network.ts; every request also settles on disconnect. */
export class DebugRemote {
  private socket: WebSocket | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private pending: { id: number; resolve: (data: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private nextId = 0;
  private closed = false;
  private opening: ((error: Error) => void) | null = null;
  constructor(private url: string, private timeout: number,
    private event: (message: DebugMessage) => void, private disconnected: (error: Error) => void,
    private createSocket = (url: string) => new WebSocket(url, ['debug'])) {}

  async connect(username: string, password: string): Promise<void> {
    if (this.closed || this.socket) { throw new Error('调试连接已关闭或已建立。'); }
    const socket = this.socket = this.createSocket(this.url);
    socket.binaryType = 'arraybuffer';
    socket.onmessage = event => {
      try {
        const message = parseDebugMessage(event.data);
        if (message.event) {
          if (message.message !== 'OK' && message.event !== 'ERROR' && message.event !== 'SYNTAX') { throw new Error(message.message); }
          this.event(message); return;
        }
        if (this.pending?.id !== message.id) { return; }
        const pending = this.pending!; this.pending = null; clearTimeout(pending.timer);
        if (message.message === 'OK') { pending.resolve(message.data); }
        else { pending.reject(new Error(message.message)); }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    };
    socket.onclose = () => this.fail(new Error('DolphinDB 调试连接已断开。'));
    socket.onerror = () => this.fail(new Error('无法连接 DolphinDB 调试服务；服务器需支持 debug 协议（2.00.10.1 / 1.30.22.1 及以上）。'));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('连接调试服务器超时。')), this.timeout);
      this.opening = error => { clearTimeout(timer); reject(error); };
      socket.onopen = () => { clearTimeout(timer); this.opening = null; resolve(); };
    });
    if (username) { await this.call('login', [username, password]); }
  }

  call<T = any>(func: string, data?: unknown): Promise<T> {
    const result = this.tail.then(() => new Promise<T>((resolve, reject) => {
      if (this.closed || this.socket?.readyState !== 1) { reject(new Error('调试会话已关闭。')); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => this.fail(new Error(`调试请求 ${func} 超时，已关闭连接。`)), this.timeout);
      this.pending = { id, resolve, reject, timer };
      try { this.socket.send(json2ddbdict(data === undefined ? { id, func } : { id, func, data }).pack()); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    }));
    this.tail = result.catch(() => {});
    return result;
  }

  close(): void { this.finish(new Error('调试会话已关闭。')); }
  private fail(error: Error): void { if (this.closed) { return; } this.finish(error); this.disconnected(error); }
  private finish(error: Error): void {
    if (this.closed) { return; }
    this.closed = true;
    this.opening?.(error); this.opening = null;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
    if (this.socket) {
      this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
      this.socket.close();
    }
  }
}
