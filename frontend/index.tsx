import { ILayoutRestorer, ILabShell, type JupyterFrontEnd, type JupyterFrontEndPlugin } from '@jupyterlab/application';
import { Dialog, ICommandPalette, ReactWidget, showDialog } from '@jupyterlab/apputils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { LabIcon } from '@jupyterlab/ui-components';
import type { Message } from '@lumino/messaging';
import * as React from 'react';
import { ConnectionModel } from './model';
import { ConnectionPanel } from './panel';
import { IExtensionSettings, SETTINGS_ID, SettingsModel } from './settings';
import { IConnectionModel } from './tokens';
import dosPlugin from './dos/plugin';

const icon = new LabIcon({ name: 'dolphindb-extension:connections', svgstr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g class="jp-icon3" fill="none" stroke="#616161" stroke-width="1.6" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="7.5" ry="3"/><path d="M4.5 5v7c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5M4.5 12v7c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-7"/></g></svg>' });

export { IConnectionModel } from './tokens';
export { IExtensionSettings, SETTINGS_ID } from './settings';
export type { ExtensionSettings } from './settings';

class Sidebar extends ReactWidget {
  constructor(readonly model: ConnectionModel, readonly onOpenSettings: () => void) {
    super();
    this.id = 'dolphindb-connections';
    this.title.icon = icon;
    this.title.caption = 'DolphinDB 连接';
    this.addClass('ddb-sidebar');
  }

  render(): React.ReactElement { return <ConnectionPanel model={this.model} onOpenSettings={this.onOpenSettings} />; }

  protected onAfterShow(message: Message): void {
    super.onAfterShow(message);
    void this.model.refresh();
  }

  dispose(): void {
    this.model.dispose();
    super.dispose();
  }
}

const settingsPlugin: JupyterFrontEndPlugin<SettingsModel> = {
  id: SETTINGS_ID,
  description: 'Shared DolphinDB preferences from the Jupyter settings registry',
  autoStart: true,
  provides: IExtensionSettings,
  optional: [ISettingRegistry],
  activate: async (_app: JupyterFrontEnd, registry: ISettingRegistry | null) => {
    const preferences = new SettingsModel();
    if (registry) {
      try {
        preferences.bind(await registry.load(SETTINGS_ID));
      } catch {
        preferences.loadError = '无法加载 DolphinDB 设置，暂用默认值。请修复设置后刷新页面。';
      }
    }
    return preferences;
  },
};

const plugin: JupyterFrontEndPlugin<ConnectionModel> = {
  id: 'dolphindb-extension:connections',
  description: 'Visual DolphinDB connection management',
  autoStart: true,
  provides: IConnectionModel,
  requires: [IExtensionSettings],
  optional: [ICommandPalette, ILayoutRestorer, ILabShell],
  activate: (app: JupyterFrontEnd, preferences: SettingsModel, palette: ICommandPalette | null, restorer: ILayoutRestorer | null, labShell: ILabShell | null) => {
    const model = new ConnectionModel(preferences);
    const settingsCommand = 'dolphindb-extension:open-settings';
    app.commands.addCommand(settingsCommand, {
      label: 'DolphinDB: 设置',
      execute: async () => {
        if (app.commands.hasCommand('settingeditor:open')) {
          labShell?.collapseLeft();
          await app.commands.execute('settingeditor:open', { query: 'DolphinDB' });
        } else {
          await showDialog({
            title: 'DolphinDB 设置',
            body: '请在 JupyterLab 的 Settings → Settings Editor 中搜索 DolphinDB，配置默认值和侧栏显示。',
            buttons: [Dialog.okButton({ label: '知道了' })],
          });
        }
      },
    });
    const sidebar = new Sidebar(model, () => { void app.commands.execute(settingsCommand); });
    // Notebook 7 exposes the right sidebar; JupyterLab uses the left activity bar.
    app.shell.add(sidebar, labShell ? 'left' : 'right', { rank: 650 });
    restorer?.add(sidebar, 'dolphindb-connections');
    app.commands.addCommand('dolphindb-extension:open-connections', {
      label: 'DolphinDB: 管理连接',
      execute: () => app.shell.activateById(sidebar.id),
    });
    palette?.addItem({ command: 'dolphindb-extension:open-connections', category: 'DolphinDB' });
    palette?.addItem({ command: settingsCommand, category: 'DolphinDB' });
    return model;
  },
};

export default [settingsPlugin, plugin, dosPlugin];
