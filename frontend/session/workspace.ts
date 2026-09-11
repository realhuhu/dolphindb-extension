import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ILayoutRestorer } from '@jupyterlab/application';
import { Token } from '@lumino/coreutils';
import { DisposableDelegate } from '@lumino/disposable';
import type { Widget } from '@lumino/widgets';
import { dataExplorerIcon } from '../icons';
import { WorkspacePanel } from '../dos/views';
import type { WorkspaceBinding } from './types';

export class SessionWorkspace {
  readonly panel: WorkspacePanel;
  private bindings = new Map<Widget, WorkspaceBinding>();
  constructor(private app: JupyterFrontEnd) {
    this.panel = new WorkspacePanel(app.shell.node);
    this.panel.id = 'dolphindb-document-workspace';
    this.panel.title.icon = dataExplorerIcon;
    this.panel.title.caption = 'DolphinDB 数据库与变量';
    this.panel.addClass('ddb-dos-workspace');
    app.shell.add(this.panel, 'right', { rank: 600 });
    app.shell.currentChanged?.connect(() => this.sync());
    void app.restored.then(() => this.sync());
  }
  register(widget: Widget, binding: WorkspaceBinding): DisposableDelegate {
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
    if (binding && (reveal || previous !== binding)) { this.app.shell.activateById(this.panel.id); }
  }
}

export const ISessionWorkspace = new Token<SessionWorkspace>('dolphindb-extension:ISessionWorkspace');
export default {
  id: 'dolphindb-extension:workspace', autoStart: true, provides: ISessionWorkspace,
  optional: [ILayoutRestorer],
  activate: (app: JupyterFrontEnd, restorer: ILayoutRestorer | null) => {
    const workspace = new SessionWorkspace(app);
    restorer?.add(workspace.panel, 'dolphindb-document-workspace');
    return workspace;
  },
} satisfies JupyterFrontEndPlugin<SessionWorkspace>;
