import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Token } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import type { Draft, Profile } from './api';

export const SETTINGS_ID = 'dolphindb-extension:settings';
export const IExtensionSettings = new Token<SettingsModel>('dolphindb-extension:IExtensionSettings');

export interface ExtensionSettings {
  readonly display: { readonly decimals: number | null };
  readonly dataBrowser: { readonly pageSize: number; readonly columnPageSize: number };
  readonly preview: { readonly tableRows: number; readonly variableHover: boolean; readonly tableHover: boolean; readonly hoverDelay: number };
  readonly output: { readonly autoScroll: boolean; readonly defaultExpanded: boolean };
  readonly execution: { readonly stopOnError: boolean };
  readonly advanced: { readonly variablePreviewBytes: number; readonly cacheEntries: number; readonly cacheMegabytes: number;
    readonly historyEntries: number; readonly historyMegabytes: number; readonly metadataTimeout: number };
  readonly language: { readonly moduleRoot: string; readonly documentationLanguage: 'zh' | 'en'; readonly automaticCompletion: boolean;
    readonly hoverDocumentation: boolean; readonly signatureHelp: boolean; readonly diagnostics: boolean };
  readonly connectionDefaults: Readonly<Pick<Draft, 'port' | 'username' | 'timeout' | 'ssl'>>;
  readonly sidebar: {
    readonly sortOrder: 'saved' | 'name' | 'host';
    readonly showConnectionDetails: boolean;
    readonly showConnectionAddress: boolean;
    readonly alwaysShowSearch: boolean;
    readonly autoOpenWorkspace: boolean;
    readonly collapseLeftOnNarrow: boolean;
  };
}

// Keep the fallback usable in applications without a settings registry.
// schema/settings.json defines the matching user-facing defaults and validation.
export const DEFAULT_SETTINGS: ExtensionSettings = Object.freeze({
  display: Object.freeze({ decimals: null }),
  dataBrowser: Object.freeze({ pageSize: 100, columnPageSize: 50 }),
  preview: Object.freeze({ tableRows: 100, variableHover: true, tableHover: true, hoverDelay: 350 }),
  output: Object.freeze({ autoScroll: true, defaultExpanded: true }),
  execution: Object.freeze({ stopOnError: true }),
  advanced: Object.freeze({ variablePreviewBytes: 10240, cacheEntries: 20, cacheMegabytes: 64, historyEntries: 20, historyMegabytes: 8, metadataTimeout: 4 }),
  language: Object.freeze({ moduleRoot: '', documentationLanguage: 'zh', automaticCompletion: true, hoverDocumentation: true, signatureHelp: true, diagnostics: true }),
  connectionDefaults: Object.freeze({ port: 8848, username: 'admin', timeout: 10, ssl: false }),
  sidebar: Object.freeze({ sortOrder: 'saved', showConnectionDetails: true, showConnectionAddress: true, alwaysShowSearch: false, autoOpenWorkspace: true, collapseLeftOnNarrow: true }),
});

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function integer(value: unknown, fallback: number, maximum: number, minimum = 1): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value : fallback;
}
const boolean = (value: unknown, fallback = true): boolean => typeof value === 'boolean' ? value : fallback;

/** Resolve partial user/admin overrides without leaking settings into connection profiles. */
export function resolveSettings(composite: unknown): ExtensionSettings {
  const input = object(composite);
  const connection = object(input.connectionDefaults);
  const sidebar = object(input.sidebar);
  const defaults = DEFAULT_SETTINGS;
  const language = object(input.language);
  const browser = object(input.dataBrowser), preview = object(input.preview), output = object(input.output), advanced = object(input.advanced);
  const decimals = object(input.display).decimals;
  return Object.freeze({
    display: Object.freeze({ decimals: typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 20 ? decimals : null }),
    dataBrowser: Object.freeze({ pageSize: integer(browser.pageSize, 100, 1000), columnPageSize: integer(browser.columnPageSize, 50, 200) }),
    preview: Object.freeze({ tableRows: integer(preview.tableRows, 100, 1000), variableHover: boolean(preview.variableHover), tableHover: boolean(preview.tableHover), hoverDelay: integer(preview.hoverDelay, 350, 2000, 0) }),
    output: Object.freeze({ autoScroll: boolean(output.autoScroll), defaultExpanded: boolean(output.defaultExpanded) }),
    execution: Object.freeze({ stopOnError: boolean(object(input.execution).stopOnError) }),
    advanced: Object.freeze({ variablePreviewBytes: integer(advanced.variablePreviewBytes, 10240, 1048576, 1024), cacheEntries: integer(advanced.cacheEntries, 20, 200),
      cacheMegabytes: integer(advanced.cacheMegabytes, 64, 1024), historyEntries: integer(advanced.historyEntries, 20, 200), historyMegabytes: integer(advanced.historyMegabytes, 8, 64), metadataTimeout: integer(advanced.metadataTimeout, 4, 120) }),
    language: Object.freeze({
      moduleRoot: typeof language.moduleRoot === 'string' ? language.moduleRoot.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '',
      documentationLanguage: language.documentationLanguage === 'en' ? 'en' : 'zh',
      automaticCompletion: typeof language.automaticCompletion === 'boolean' ? language.automaticCompletion : true,
      hoverDocumentation: boolean(language.hoverDocumentation), signatureHelp: boolean(language.signatureHelp), diagnostics: boolean(language.diagnostics),
    }),
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
      showConnectionAddress: boolean(sidebar.showConnectionAddress), autoOpenWorkspace: boolean(sidebar.autoOpenWorkspace), collapseLeftOnNarrow: boolean(sidebar.collapseLeftOnNarrow),
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
