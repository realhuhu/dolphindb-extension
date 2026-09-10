import { Signal } from '@lumino/signaling';
import { request, socketUrl, type Draft, type Profile, type SessionTicket, type Snapshot } from './api';
import { DdbConnection } from './upstream/connection';
import { SettingsModel } from './settings';

export class ConnectionModel {
  readonly changed = new Signal<this, void>(this);
  state: Snapshot = { connections: [], activeId: null, credentialStorage: false };
  busy: string | null = null;
  loaded = false;
  notice: { kind: 'error' | 'success'; text: string } | null = null;
  current: { id: string; connection: DdbConnection } | null = null;

  constructor(readonly preferences: SettingsModel = new SettingsModel()) {
    preferences.changed.connect(this.settingsChanged, this);
    if (preferences.loadError) { this.notice = { kind: 'error', text: preferences.loadError }; }
  }

  private settingsChanged(): void { this.changed.emit(); }

  dispose(): void {
    this.preferences.changed.disconnect(this.settingsChanged, this);
    this.disconnect();
    Signal.clearData(this);
  }

  get connected(): boolean {
    return Boolean(this.current?.connection.ddb.connected && this.current.connection.connected);
  }

  async refresh(): Promise<void> {
    await this.perform('refresh', async () => {
      this.state = await request<Snapshot>('connections');
      this.loaded = true;
    }, false);
  }

  private async perform(label: string, action: () => Promise<void>, clear = true): Promise<boolean> {
    if (this.busy) { return false; }
    this.busy = label;
    if (clear) { this.notice = null; }
    this.changed.emit();
    try {
      await action();
      return true;
    } catch (error) {
      this.notice = { kind: 'error', text: error instanceof Error ? error.message : '操作失败，请重试。' };
      return false;
    } finally {
      this.busy = null;
      this.changed.emit();
    }
  }

  async save(draft: Draft): Promise<boolean> {
    return this.perform('save', async () => {
      this.state = await request<Snapshot>(draft.id ? `connections/${draft.id}` : 'connections', draft.id ? 'PUT' : 'POST', draft);
      this.notice = { kind: 'success', text: `已保存连接「${draft.name}」。` };
    });
  }

  async remove(profile: Profile): Promise<void> {
    await this.perform(`delete:${profile.id}`, async () => {
      this.state = await request<Snapshot>(`connections/${profile.id}`, 'DELETE');
      if (this.current?.id === profile.id) { this.disconnect(); }
      this.notice = { kind: 'success', text: `已删除连接「${profile.name}」。` };
    });
  }

  private async open(draft: Draft | { id: string }, name: string): Promise<DdbConnection> {
    const ticket = await request<SessionTicket>('sessions', 'POST', draft);
    const connection = new DdbConnection(socketUrl(ticket.path), name, {
      autologin: Boolean(ticket.username), username: ticket.username,
      password: ticket.password, verbose: false,
    });
    // No password is kept in a browser profile, settings, localStorage, or IndexedDB.
    ticket.password = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connection.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), ticket.timeout * 1000);
        }),
      ]);
      return connection;
    } catch (error) {
      connection.disconnect();
      throw new Error(error instanceof Error && error.message === 'timeout'
        ? '连接超时，请检查服务器是否可达，或调整连接超时。'
        : '连接失败，请检查服务器地址、端口、用户名、密码和 SSL 设置。');
    } finally {
      clearTimeout(timer);
    }
  }

  async test(draft: Draft): Promise<void> {
    await this.perform('test', async () => {
      const started = performance.now();
      const connection = await this.open(draft, draft.name);
      try {
        this.notice = { kind: 'success', text: `连接成功 · ${connection.node_alias || 'DolphinDB'} · v${connection.version} · ${Math.round(performance.now() - started)} ms` };
      } finally {
        connection.disconnect();
      }
    });
  }

  async connect(profile: Profile): Promise<void> {
    await this.perform(`connect:${profile.id}`, async () => {
      const next = await this.open({ id: profile.id }, profile.name);
      try {
        this.state = await request<Snapshot>('active', 'PUT', { connectionId: profile.id });
      } catch (error) {
        next.disconnect();
        throw error;
      }
      // Retain the old session until the replacement has connected and been selected.
      this.current?.connection.disconnect();
      this.current = { id: profile.id, connection: next };
      this.notice = { kind: 'success', text: `已连接「${profile.name}」。` };
    });
  }

  disconnect(): void {
    this.current?.connection.disconnect();
    this.current = null;
    this.changed.emit();
  }
}
