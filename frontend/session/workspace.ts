import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ILabShell, ILayoutRestorer } from '@jupyterlab/application';
import { Token } from '@lumino/coreutils';
import { DisposableDelegate } from '@lumino/disposable';
import type { Widget } from '@lumino/widgets';
import { dataExplorerIcon } from '../icons';
import { WorkspacePanel } from '../dos/views';
import type { WorkspaceBinding } from './types';
import { IDataBrowser, type DataBrowser } from '../data/plugin';
import { IExtensionSettings, type SettingsModel } from '../settings';

export class SessionWorkspace {
  readonly panel: WorkspacePanel;
  private bindings = new Map<Widget, WorkspaceBinding>();
  private restored = false;
  private autoRevealPending = true;
  constructor(private app: JupyterFrontEnd, readonly browser: DataBrowser, readonly preferences: SettingsModel, labShell: ILabShell | null = null) {
    this.panel = new WorkspacePanel(app.shell.node);
    this.panel.id = 'dolphindb-document-workspace';
    this.panel.title.icon = dataExplorerIcon;
    this.panel.title.caption = 'DolphinDB 数据库与变量';
    this.panel.addClass('ddb-dos-workspace');
    app.shell.add(this.panel, 'right', { rank: 600 });
    app.shell.currentChanged?.connect(() => this.sync());
    void (labShell?.restored ?? app.restored).then(layout => {
      // Jupyter restores sidebar visibility, including a manual collapse or a
      // different selected tab. Only introduce the panel once in a new layout.
      if (layout?.rightArea?.widgets?.includes(this.panel) || layout?.rightArea?.currentWidget) {
        this.autoRevealPending = false;
      }
      this.restored = true;
      this.sync();
    });
  }
  register(widget: Widget, binding: WorkspaceBinding): DisposableDelegate {
    binding.openData = (target, title) => {
      const identity = binding.model.browserIdentity();
      this.browser.open({ title: `${title} · ${binding.path().split('/').pop()}`, read: query => {
        if (widget.isDisposed || identity !== binding.model.browserIdentity()) { return Promise.reject(new Error('原文档会话已变化，请从原文档重新打开。')); }
        return binding.model.browse(target, query);
      } });
    };
    this.bindings.set(widget, binding);
    this.sync();
    return new DisposableDelegate(() => { this.bindings.delete(widget); this.sync(); });
  }
  /** Track main-area documents, never let a DOS-only tracker clear a notebook. */
  sync(reveal = false): void {
    const binding = this.bindings.get(this.app.shell.currentWidget!) ?? null;
    const previous = this.panel.binding;
    if (previous?.model !== binding?.model) {
      previous?.model.setPanelActive?.(false);
      binding?.model.setPanelActive?.(true);
    }
    this.panel.setBinding(binding);
    if (!binding) { return; }
    if (reveal) {
      this.autoRevealPending = false;
      this.app.shell.activateById(this.panel.id);
    } else if (this.restored && this.autoRevealPending) {
      // Subsequent document changes only update content; they must not reopen a
      // collapsed sidebar or replace another sidebar tab selected by the user.
      this.autoRevealPending = false;
      if (this.preferences.value.sidebar.autoOpenWorkspace) { this.app.shell.activateById(this.panel.id); }
    }
  }
}

export const ISessionWorkspace = new Token<SessionWorkspace>('dolphindb-extension:ISessionWorkspace');
export default {
  id: 'dolphindb-extension:workspace', autoStart: true, provides: ISessionWorkspace,
  requires: [IDataBrowser, IExtensionSettings],
  optional: [ILayoutRestorer, ILabShell],
  activate: (app: JupyterFrontEnd, browser: DataBrowser, preferences: SettingsModel, restorer: ILayoutRestorer | null, labShell: ILabShell | null) => {
    const workspace = new SessionWorkspace(app, browser, preferences, labShell);
    restorer?.add(workspace.panel, 'dolphindb-document-workspace');
    return workspace;
  },
} satisfies JupyterFrontEndPlugin<SessionWorkspace>;
