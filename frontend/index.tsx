import { ILayoutRestorer, ILabShell, type JupyterFrontEnd, type JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ICommandPalette, ReactWidget } from '@jupyterlab/apputils';
import { LabIcon } from '@jupyterlab/ui-components';
import { Token } from '@lumino/coreutils';
import type { Message } from '@lumino/messaging';
import * as React from 'react';
import { ConnectionModel } from './model';
import { ConnectionPanel } from './panel';

const icon = new LabIcon({ name: 'dolphindb-extension:connections', svgstr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g class="jp-icon3" fill="none" stroke="#616161" stroke-width="1.6" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="7.5" ry="3"/><path d="M4.5 5v7c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5M4.5 12v7c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-7"/></g></svg>' });

export const IConnectionModel = new Token<ConnectionModel>('dolphindb-extension:IConnectionModel');

class Sidebar extends ReactWidget {
  constructor(readonly model: ConnectionModel) {
    super();
    this.id = 'dolphindb-connections';
    this.title.icon = icon;
    this.title.caption = 'DolphinDB 连接';
    this.addClass('ddb-sidebar');
  }

  render(): React.ReactElement { return <ConnectionPanel model={this.model} />; }

  protected onAfterShow(message: Message): void {
    super.onAfterShow(message);
    void this.model.refresh();
  }

  dispose(): void {
    this.model.disconnect();
    super.dispose();
  }
}

const plugin: JupyterFrontEndPlugin<ConnectionModel> = {
  id: 'dolphindb-extension:connections',
  description: 'Visual DolphinDB connection management',
  autoStart: true,
  provides: IConnectionModel,
  optional: [ICommandPalette, ILayoutRestorer, ILabShell],
  activate: (app: JupyterFrontEnd, palette: ICommandPalette | null, restorer: ILayoutRestorer | null, labShell: ILabShell | null) => {
    const model = new ConnectionModel();
    const sidebar = new Sidebar(model);
    // Notebook 7 exposes the right sidebar; JupyterLab uses the left activity bar.
    app.shell.add(sidebar, labShell ? 'left' : 'right', { rank: 650 });
    restorer?.add(sidebar, 'dolphindb-connections');
    app.commands.addCommand('dolphindb-extension:open-connections', {
      label: 'DolphinDB: 管理连接',
      execute: () => app.shell.activateById(sidebar.id),
    });
    palette?.addItem({ command: 'dolphindb-extension:open-connections', category: 'DolphinDB' });
    return model;
  },
};

export default plugin;
