import type { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ICommandPalette, InputDialog } from '@jupyterlab/apputils';
import { EditorExtensionRegistry, IEditorExtensionRegistry } from '@jupyterlab/codemirror';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Token } from '@lumino/coreutils';
import { IExtensionSettings, type SettingsModel } from '../settings';
import { LanguageEditors } from './editor';
import { LanguageEngine } from './engine';
import { ModuleIndex } from './modules';
import { languageSupport } from '../dos/language';

export const ILanguageEditors = new Token<LanguageEditors>('dolphindb-extension:ILanguageEditors');
export default {
  id: 'dolphindb-extension:language', autoStart: true, provides: ILanguageEditors,
  requires: [IEditorExtensionRegistry, IRenderMimeRegistry, IExtensionSettings], optional: [ICommandPalette],
  activate: async (app, registry: IEditorExtensionRegistry, rendermime: IRenderMimeRegistry, settings: SettingsModel, palette: ICommandPalette | null) => {
    const modules = new ModuleIndex(app.serviceManager.contents);
    const service = new LanguageEditors(new LanguageEngine(modules, () => settings.value.language), settings, rendermime, await languageSupport());
    registry.addExtension({ name: 'dolphindb-language-assistance', factory: ({ model }) => EditorExtensionRegistry.createImmutableExtension(service.extension(model)) });
    app.commands.addCommand('dolphindb-extension:refresh-modules', { label: 'DolphinDB: 刷新模块索引', execute: () => modules.refresh() });
    app.commands.addCommand('dolphindb-extension:definition', { label: 'DolphinDB: 跳转到定义', execute: () => service.active && service.jump(service.active.view, service.active.model) });
    app.commands.addCommand('dolphindb-extension:symbols', {
      label: 'DolphinDB: 跳转到符号', execute: async () => {
        const result = await service.symbols();
        if (!result?.items.length) { return; }
        const items = result.items.map((item, index) => `${index + 1}. ${item.name} · 第 ${item.range.start.line + 1} 行`);
        const answer = await InputDialog.getItem({ title: 'DolphinDB 符号', label: '跳转到符号', items, current: 0, okLabel: '跳转', cancelLabel: '取消' });
        const index = answer.value === null ? -1 : items.indexOf(answer.value);
        if (answer.button.accept && index >= 0) { await result.binding.open(result.binding.path(), result.items[index].selectionRange); }
      },
    });
    for (const command of ['dolphindb-extension:refresh-modules', 'dolphindb-extension:definition', 'dolphindb-extension:symbols']) { palette?.addItem({ command, category: 'DolphinDB' }); }
    return service;
  },
} satisfies JupyterFrontEndPlugin<LanguageEditors>;
