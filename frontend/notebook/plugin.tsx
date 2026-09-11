import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { IEditorLanguageRegistry } from '@jupyterlab/codemirror';
import type { CodeEditor } from '@jupyterlab/codeeditor';
import { INotebookTracker, NotebookActions, type NotebookPanel } from '@jupyterlab/notebook';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { IConnectionModel } from '../tokens';
import type { ConnectionModel } from '../model';
import { DOS_MIME, languageSupport } from '../dos/language';
import type { NotebookConnection } from './model';
import { notebookConnection } from './executor-plugin';
import { ILanguageEditors } from '../language/plugin';
import type { LanguageEditors } from '../language/editor';
import { projection, projectDdb } from '../language/regions';
import { IDocumentManager } from '@jupyterlab/docmanager';
import type { DocumentWidget } from '@jupyterlab/docregistry';
import type { FileEditor } from '@jupyterlab/fileeditor';
import { ISessionWorkspace, type SessionWorkspace } from '../session/workspace';
import { SessionToolbar } from '../session/toolbar';
import { registerDdbRenderer } from '../dos/output';
import { captureVariableInsertion } from '../session/interactions';
import { showTablePreview } from '../session/preview';

function createNotebookToolbar(model: NotebookConnection, insert: () => void, showWorkspace: () => void): SessionToolbar {
  return new SessionToolbar({ label: 'Notebook DolphinDB 工具栏', changed: model.changed,
    state: () => ({ profiles: model.connections.state.connections, profile: model.profile, defaultProfile: model.defaultProfile,
      selection: model.selection, locked: model.locked, busy: model.busy, disabled: model.phase !== 'ready' || model.locked || model.executing || model.loading,
      canClose: model.phase === 'ready' && model.locked && !model.executing && !model.loading, status: model.status, label: 'Notebook DolphinDB 连接',
      closeDescription: '关闭当前 Python 内核的 DolphinDB 会话？DDB 会话变量将被释放，Notebook 内容和 Python 变量会保留。',
      select: id => model.select(id), close: () => model.closeSession(), showWorkspace }),
    actions: [
      { name: 'insert', label: 'DDB 单元格', tooltip: '插入 %%ddb 代码单元格；Shift + Enter 执行', run: insert },
      { name: 'retry', label: '重试 DDB', tooltip: '重新初始化 DolphinDB 连接', run: () => model.initialize(), visible: () => model.phase === 'error' },
    ] });
}

export default {
  id: 'dolphindb-extension:notebook', autoStart: true,
  requires: [IConnectionModel, INotebookTracker, IEditorLanguageRegistry, ILanguageEditors, IDocumentManager, ISessionWorkspace, IRenderMimeRegistry],
  optional: [ICommandPalette],
  activate: async (app: JupyterFrontEnd, connections: ConnectionModel, notebooks: INotebookTracker,
    languages: IEditorLanguageRegistry, languageEditors: LanguageEditors, documents: IDocumentManager, workspace: SessionWorkspace, rendermime: IRenderMimeRegistry, palette: ICommandPalette | null) => {
    registerDdbRenderer(rendermime);
    if (!connections.loaded) { void connections.refresh(); }
    if (!languages.findByMIME(DOS_MIME)) {
      languages.addLanguage({ name: 'DolphinDB', mime: DOS_MIME, extensions: ['dos'], load: async () => languageSupport() });
    }
    // CodeMirrorEditor applies asynchronous language loads without discarding
    // stale requests. Finish Python's initial load before switching cells to DDB,
    // otherwise that late result can overwrite an already highlighted %%ddb cell.
    await Promise.all(['text/x-python', 'text/x-ipython', DOS_MIME].map(mime => languages.getLanguage(mime)));
    const models = new WeakMap<NotebookPanel, NotebookConnection>();
    const insert = (panel: NotebookPanel) => {
      NotebookActions.insertBelow(panel.content);
      NotebookActions.changeCellType(panel.content, 'code');
      panel.content.activeCell?.model.sharedModel.setSource('%%ddb\n// 输入 DolphinDB 代码，Shift + Enter 执行\n1 + 1');
      panel.content.mode = 'edit';
      panel.content.activeCell?.editor?.focus();
    };
    const attach = (panel: NotebookPanel) => {
      if (models.has(panel)) { return; }
      const model = notebookConnection(panel.sessionContext, connections);
      let browserOwner = '', removeBrowser = () => {};
      const bindBrowser = () => {
        if (browserOwner !== model.browserOwner) {
          removeBrowser(); browserOwner = model.browserOwner;
          removeBrowser = browserOwner ? workspace.browser.register(browserOwner, (target, query) => model.browse(target, query)) : () => {};
        }
      };
      model.changed.connect(bindBrowser); bindBrowser();
      models.set(panel, model);
      const isCurrent = () => !panel.isDisposed && app.shell.currentWidget === panel;
      const workspaceBinding = workspace.register(panel, {
        model, path: () => panel.context.path, scope: 'kernel', isCurrent,
        identity: () => `${panel.sessionContext.session?.kernel?.id}:${model.profile?.id}:${model.languageRevision}`,
        captureInsertion: name => {
          const cell = panel.content.activeCell;
          if (cell?.model.type !== 'code') { return null; }
          return captureVariableInsertion(cell.editor, name, () => isCurrent() && panel.content.activeCell === cell,
            () => { panel.content.mode = 'edit'; });
        },
      });
      const preview = (_sender: NotebookConnection, result: { title: string; value: import('../dos/runtime').DisplayValue }) => {
        if (app.shell.currentWidget === panel) {
          showTablePreview(result, rendermime);
        }
      };
      model.previewReady.connect(preview);
      const toolbar = createNotebookToolbar(model, () => insert(panel), () => workspace.sync(true));
      toolbar.addClass('ddb-notebook-header');
      panel.contentHeader.addWidget(toolbar);
      const unbind = new Map<CodeEditor.IModel, () => void>();
      const highlight = () => {
        for (const cell of panel.content.widgets) {
          if (cell.model.type !== 'code') { continue; }
          // Cell models are editor models even before Jupyter renders the editor.
          // Bind now so virtualized/offscreen cells are highlighted on first display.
          const ddb = /^%%ddb(?:\s|$)/.test(cell.model.sharedModel.getSource());
          if (ddb) { cell.model.mimeType = DOS_MIME; }
          else if (cell.model.mimeType === DOS_MIME) { cell.model.mimeType = 'text/x-ipython'; }
          if (!unbind.has(cell.model)) {
            unbind.set(cell.model, languageEditors.bind(cell.model, {
              path: () => panel.context.path, source: () => cell.model.sharedModel.getSource(),
              project: (source, offset) => {
                const cells = panel.content.widgets;
                const index = cells.indexOf(cell);
                const result = projection(source, offset, false, cells.slice(0, index).map(c => c.model.type === 'code' ? c.model.sharedModel.getSource() : ''));
                if (result) { result.source += cells.slice(index + 1).map(c => '\n' + (c.model.type === 'code' ? projectDdb(c.model.sharedModel.getSource()) : '')).join(''); }
                return result;
              },
              metadata: (operation, args) => model.metadata(operation, args),
              nativeComplete: () => {
                if (!app.commands.hasCommand('completer:invoke-notebook')) { return false; }
                void app.commands.execute('completer:invoke-notebook', { activate: false });
                return true;
              },
              identity: () => `${panel.sessionContext.session?.kernel?.id}:${model.profile?.id}:${model.languageRevision}`,
              open: async (uri, range) => {
                if (uri !== panel.context.path) {
                  const target = documents.openOrReveal(uri, 'Editor') as DocumentWidget<FileEditor> | undefined;
                  if (target) { await target.context.ready; target.content.editor.setCursorPosition({ line: range.start.line, column: range.start.character }); target.content.editor.focus(); }
                  return;
                }
                let line = range.start.line;
                for (let i = 0; i < panel.content.widgets.length; i++) {
                  const target = panel.content.widgets[i];
                  const count = target.model.type === 'code' ? target.model.sharedModel.getSource().split('\n').length : 1;
                  if (line < count) { panel.content.activeCellIndex = i; panel.content.mode = 'edit'; target.editor?.setCursorPosition({ line, column: range.start.character }); target.editor?.focus(); break; }
                  line -= count;
                }
              },
            }));
          }
        }
        const current = new Set<CodeEditor.IModel>(panel.content.widgets.filter(cell => cell.model.type === 'code').map(cell => cell.model));
        for (const [editor, dispose] of unbind) { if (!current.has(editor)) { dispose(); unbind.delete(editor); } }
      };
      void panel.context.ready.then(() => {
        if (panel.isDisposed) { return; }
        panel.content.model?.contentChanged.connect(highlight);
        // Kernel language_info resets every code cell's MIME type. Reapply DDB
        // after Jupyter's metadata handler, including during notebook restoration.
        panel.content.model?.metadataChanged.connect(highlight);
        panel.content.activeCellChanged.connect(highlight);
        highlight();
        workspace.sync();
      });
      panel.disposed.connect(() => {
        model.changed.disconnect(bindBrowser); removeBrowser();
        workspaceBinding.dispose();
        model.previewReady.disconnect(preview);
        for (const dispose of unbind.values()) { dispose(); }
        panel.content.model?.contentChanged.disconnect(highlight);
        panel.content.model?.metadataChanged.disconnect(highlight);
        panel.content.activeCellChanged.disconnect(highlight);
      });
    };
    notebooks.widgetAdded.connect((_tracker, panel) => attach(panel));
    notebooks.forEach(attach);
    const command = 'dolphindb-extension:insert-ddb-cell';
    app.commands.addCommand(command, {
      label: 'DolphinDB: 插入 DDB 单元格', isEnabled: () => Boolean(notebooks.currentWidget),
      execute: () => { if (notebooks.currentWidget) { insert(notebooks.currentWidget); } },
    });
    palette?.addItem({ command, category: 'DolphinDB' });
  },
} satisfies JupyterFrontEndPlugin<void>;
