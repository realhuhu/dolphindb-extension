import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Token } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import type { Draft, Profile } from './api';

export const SETTINGS_ID = 'dolphindb-extension:settings';
export const IExtensionSettings = new Token<SettingsModel>('dolphindb-extension:IExtensionSettings');

export interface ExtensionSettings {
  readonly connectionDefaults: Readonly<Pick<Draft, 'port' | 'username' | 'timeout' | 'ssl'>>;
  readonly sidebar: {
    readonly sortOrder: 'saved' | 'name' | 'host';
    readonly showConnectionDetails: boolean;
    readonly alwaysShowSearch: boolean;
  };
}

// Keep the fallback usable in applications without a settings registry.
// schema/settings.json defines the matching user-facing defaults and validation.
export const DEFAULT_SETTINGS: ExtensionSettings = Object.freeze({
  connectionDefaults: Object.freeze({ port: 8848, username: 'admin', timeout: 10, ssl: false }),
  sidebar: Object.freeze({ sortOrder: 'saved', showConnectionDetails: true, alwaysShowSearch: false }),
});

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function integer(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maximum
    ? value : fallback;
}

/** Resolve partial user/admin overrides without leaking settings into connection profiles. */
export function resolveSettings(composite: unknown): ExtensionSettings {
  const input = object(composite);
  const connection = object(input.connectionDefaults);
  const sidebar = object(input.sidebar);
  const defaults = DEFAULT_SETTINGS;
  return Object.freeze({
    connectionDefaults: Object.freeze({
      port: integer(connection.port, defaults.connectionDefaults.port, 65535),
      timeout: integer(connection.timeout, defaults.connectionDefaults.timeout, 60),
      username: typeof connection.username === 'string' && connection.username.length <= 128
        && !/[\u0000-\u001f]/.test(connection.username)
        ? connection.username : defaults.connectionDefaults.username,
      ssl: typeof connection.ssl === 'boolean' ? connection.ssl : defaults.connectionDefaults.ssl,
    }),
    sidebar: Object.freeze({
      sortOrder: sidebar.sortOrder === 'name' || sidebar.sortOrder === 'host' ? sidebar.sortOrder : 'saved',
      showConnectionDetails: typeof sidebar.showConnectionDetails === 'boolean'
        ? sidebar.showConnectionDetails : defaults.sidebar.showConnectionDetails,
      alwaysShowSearch: typeof sidebar.alwaysShowSearch === 'boolean'
        ? sidebar.alwaysShowSearch : defaults.sidebar.alwaysShowSearch,
    }),
  });
}

/** Shared settings service for the sidebar and future editor/execution plugins. */
export class SettingsModel {
  readonly changed = new Signal<this, void>(this);
  loadError: string | null = null;
  private source: ISettingRegistry.ISettings | null = null;
  private current: ExtensionSettings = DEFAULT_SETTINGS;

  get value(): ExtensionSettings { return this.current; }

  bind(settings: ISettingRegistry.ISettings): void {
    this.source?.changed.disconnect(this.readSettings, this);
    this.source = settings;
    this.loadError = null;
    settings.changed.connect(this.readSettings, this);
    this.readSettings();
  }

  private readSettings(): void {
    const next = resolveSettings(this.source?.composite);
    if (JSON.stringify(next) !== JSON.stringify(this.current)) {
      this.current = next;
      this.changed.emit();
    }
  }

  createDraft(): Draft {
    return {
      name: '', host: '', ...this.current.connectionDefaults,
      password: '', rememberPassword: false,
    };
  }

  dispose(): void {
    this.source?.changed.disconnect(this.readSettings, this);
    this.source = null;
    Signal.clearData(this);
  }
}

export function sortConnections(profiles: readonly Profile[], order: ExtensionSettings['sidebar']['sortOrder']): Profile[] {
  const sorted = [...profiles];
  const compare = (a: string, b: string) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
  if (order === 'name') { sorted.sort((a, b) => compare(a.name, b.name)); }
  if (order === 'host') { sorted.sort((a, b) => compare(a.host, b.host) || a.port - b.port || compare(a.name, b.name)); }
  return sorted;
}
