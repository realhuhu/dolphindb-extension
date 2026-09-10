import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

export interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  ssl: boolean;
  timeout: number;
  rememberPassword: boolean;
  hasPassword: boolean;
}

export interface Snapshot {
  connections: Profile[];
  activeId: string | null;
  credentialStorage: boolean;
}

export type Draft = Omit<Profile, 'id' | 'hasPassword'> & { id?: string; password?: string };
export interface SessionTicket {
  path: string;
  username: string;
  password: string;
  timeout: number;
}

const settings = ServerConnection.makeSettings();

export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await ServerConnection.makeRequest(
    URLExt.join(settings.baseUrl, 'dolphindb-extension', path),
    { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
    settings
  );
  if (response.status === 204) { return undefined as T; }
  let data: { message?: string };
  try {
    data = await response.json();
  } catch {
    throw new Error('无法访问 DolphinDB 服务端扩展，请确认已安装并重启 Jupyter。');
  }
  if (!response.ok) {
    throw new Error(data.message || `请求失败（${response.status}），请刷新后重试。`);
  }
  return data as T;
}

export function socketUrl(path: string): string {
  const url = new URL(URLExt.join(settings.wsUrl, path));
  if (settings.token) {
    url.searchParams.set('token', settings.token);
  }
  return url.toString();
}

export function endpoint(profile: Pick<Profile, 'host' | 'port' | 'ssl'>): string {
  const host = profile.host.includes(':') ? `[${profile.host}]` : profile.host;
  return `${profile.ssl ? 'wss' : 'ws'}://${host}:${profile.port}`;
}
