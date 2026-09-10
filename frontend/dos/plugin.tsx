import * as React from 'react';
import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ILabShell } from '@jupyterlab/application';
import { Dialog, ICommandPalette, ReactWidget, showDialog } from '@jupyterlab/apputils';
import { IEditorLanguageRegistry } from '@jupyterlab/codemirror';
import { ICompletionProviderManager } from '@jupyterlab/completer';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IDocumentWidget } from '@jupyterlab/docregistry';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { FileEditor, IEditorTracker } from '@jupyterlab/fileeditor';
import { ILauncher } from '@jupyterlab/launcher';
import { IRunningSessionManagers } from '@jupyterlab/running';
import { LabIcon } from '@jupyterlab/ui-components';
import { DisposableDelegate } from '@lumino/disposable';
import { Panel, SplitPanel, StackedLayout } from '@lumino/widgets';
import { IConnectionModel } from '../tokens';
import type { ConnectionModel } from '../model';
import { DosManager, type DosModel } from './model';
import { completionProvider, DOS_MIME, languageSupport } from './language';
import { DosToolbar, OutputPanel, WorkspacePanel } from './views';

const DOS_ICON = new LabIcon({ name: 'dolphindb-extension:dos', svgstr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path class="jp-icon3" fill="#616161" d="M5 2h9l5 5v15H5zm9 2v5h5L14 4zM7 12v6h3c3 0 3-6 0-6zm2 2h1c1 0 1 2 0 2H9zm5-2h-2v6h2c4 0 4-6 0-6zm0 2c2 0 2 2 0 2z"/></svg>' });
const prefix = 'dolphindb-extension:';
type EditorWidget = IDocumentWidget<FileEditor>;

export default {
  id: `${prefix}dos`, autoStart: true,
  requires: [IConnectionModel, IEditorTracker, IDocumentManager, IEditorLanguageRegistry],
  optional: [ICommandPalette, ICompletionProviderManager, IRunningSessionManagers, ILauncher, IFileBrowserFactory, ILabShell],
  activate: (app: JupyterFrontEnd, connections: ConnectionModel, editors: IEditorTracker, documents: IDocumentManager, languages: IEditorLanguageRegistry,
    palette: ICommandPalette | null, completer: ICompletionProviderManager | null, running: IRunningSessionManagers | null, launcher: ILauncher | null, browsers: IFileBrowserFactory | null, labShell: ILabShell | null) => {
    const manager = new DosManager(connections);
    const workspace = new WorkspacePanel();
    workspace.id = 'dolphindb-document-workspace';
    workspace.title.icon = DOS_ICON;
    workspace.title.caption = 'DolphinDB 数据库与变量';
    workspace.addClass('ddb-dos-workspace');
    app.shell.add(workspace, 'right', { rank: 600 });
    languages.addLanguage({ name: 'DolphinDB', mime: DOS_MIME, extensions: ['dos'], load: async () => languageSupport() });
    app.docRegistry.addFileType({ name: 'dolphindb', displayName: 'DolphinDB', extensions: ['.dos'], mimeTypes: [DOS_MIME], fileFormat: 'text', contentType: 'file', icon: DOS_ICON });
    if (completer) { completer.registerProvider(completionProvider(manager)); }
    const models = new Map<EditorWidget, DosModel>();
    const active = () => models.get(editors.currentWidget!) ?? null;
    const focusWorkspace = () => {
      workspace.setModel(active());
      if (active()) { app.shell.activateById(workspace.id); }
    };
    const getSource = (widget: EditorWidget) => widget.content.model.sharedModel.getSource();
    const browser = () => browsers?.tracker.currentWidget ?? browsers?.tracker.find(() => true);
    const runFile = async (widget: EditorWidget) => {
      await widget.context.ready;
      await models.get(widget)!.run(getSource(widget), 0);
    };
    const runSelection = async (widget: EditorWidget, advance = false) => {
      const editor = widget.content.editor;
      const source = getSource(widget);
      const selected = editor.getSelections().map(range => ({ start: editor.getOffsetAt(range.start), end: editor.getOffsetAt(range.end), line: range.start.line }))
        .map(r => r.end < r.start ? { start: r.end, end: r.start, line: editor.getPositionAt(r.end)!.line } : r)
        .filter(r => r.end > r.start).sort((a, b) => a.start - b.start);
      if (selected.length) {
        for (const selection of selected) { if (!await models.get(widget)!.run(source.slice(selection.start, selection.end), selection.line)) { break; } }
      } else {
        const cursor = editor.getCursorPosition();
        await models.get(widget)!.run(source.split('\n')[cursor.line] ?? '', cursor.line);
        if (advance && cursor.line + 1 < editor.lineCount) { editor.setCursorPosition({ line: cursor.line + 1, column: 0 }); }
      }
      editor.focus();
    };

    let batchRunning = false;
    let stopBatch = false;
    const batch = async () => {
      if (batchRunning) { stopBatch = true; return; }
      const selected = [...(browser()?.selectedItems() ?? [])].filter(item => item.type === 'file' && item.path.toLowerCase().endsWith('.dos')).map(item => item.path);
      const paths = [...new Set([...models.keys()].map(w => w.context.path).concat(selected))];
      if (!paths.length) { await showDialog({ title: '批量运行 DOS', body: '先打开 DOS 文件，或在文件浏览器中选中多个 DOS 文件。' }); return; }
      await manager.ready;
      await manager.refresh();
      class BatchPicker extends ReactWidget {
        chosen = new Set(paths);
        getValue() { return paths.filter(path => this.chosen.has(path)); }
        render() { return <div className="ddb-batch-picker"><p>按以下顺序执行，各文件使用自己的连接和会话。遇到错误时停止后续文件。</p>{paths.map(path => <label key={path}><input type="checkbox" defaultChecked onChange={e => e.target.checked ? this.chosen.add(path) : this.chosen.delete(path)}/><span>{path}</span><small>{manager.profileFor(path)?.name ?? '未选择连接'}</small></label>)}</div>; }
      }
      const result = await showDialog<string[]>({ title: '批量运行 DOS', body: new BatchPicker(), buttons: [Dialog.cancelButton({ label: '取消' }), Dialog.okButton({ label: '运行所选文件' })] });
      if (!result.button.accept || !result.value?.length) { return; }
      batchRunning = true; stopBatch = false;
      try {
        const jobs: { model: DosModel; code: string; widget: EditorWidget }[] = [];
        for (const path of result.value) {
          const widget = documents.openOrReveal(path, 'Editor') as EditorWidget;
          await widget.context.ready;
          jobs.push({ model: manager.document(path), code: getSource(widget), widget });
        }
        for (const job of jobs) {
          if (stopBatch) { break; }
          app.shell.activateById(job.widget.id);
          workspace.setModel(job.model);
          if (!await job.model.run(job.code)) { break; }
        }
      } finally { batchRunning = false; }
    };

    app.docRegistry.addWidgetExtension('Editor', {
      createNew(widget: EditorWidget, context) {
        if (!context.path.toLowerCase().endsWith('.dos')) { return new DisposableDelegate(() => {}); }
        const model = manager.document(context.path);
        models.set(widget, model);
        model.open();
        widget.content.addClass('ddb-dos-editor');
        widget.title.icon = DOS_ICON;
        const layout = widget.content.layout as StackedLayout;
        const code = layout.widgets[0];
        code.parent = null;
        const split = new SplitPanel({ orientation: 'vertical', spacing: 4 });
        split.addClass('ddb-editor-split');
        split.addWidget(code);
        const output = ReactWidget.create(<OutputPanel model={model}/>);
        output.addClass('ddb-output-widget');
        split.addWidget(output);
        split.setRelativeSizes([0.7, 0.3]);
        layout.addWidget(split);
        const toolbar = ReactWidget.create(<DosToolbar model={model} runFile={() => void runFile(widget)} runSelection={() => void runSelection(widget)} batch={() => void batch()}/>);
        toolbar.addClass('ddb-toolbar-widget');
        split.parent = null;
        const body = new Panel();
        body.addClass('ddb-editor-body');
        body.addWidget(toolbar);
        body.addWidget(split);
        layout.addWidget(body);
        const renamed = () => { void model.rename(context.path); };
        context.pathChanged.connect(renamed);
        void context.ready.then(() => {
          if (app.shell.node.clientWidth < 1100) { labShell?.collapseLeft(); }
          workspace.setModel(model); app.shell.activateById(workspace.id);
        });
        return new DisposableDelegate(() => {
          context.pathChanged.disconnect(renamed);
          models.delete(widget);
          model.closeView();
          if (workspace.model === model) { workspace.setModel(active()); }
        });
      },
    });
    editors.currentChanged.connect(focusWorkspace);
    labShell?.currentChanged.connect(() => { workspace.setModel(active()); });

    const addCommand = (id: string, label: string, execute: () => unknown, needsEditor = true) => {
      app.commands.addCommand(prefix + id, { label, execute, icon: id === 'new-dos' ? DOS_ICON : undefined, isEnabled: () => !needsEditor || Boolean(active()) });
      palette?.addItem({ command: prefix + id, category: 'DolphinDB' });
    };
    addCommand('new-dos', '新建 DOS 文件', async () => {
      const file = await app.serviceManager.contents.newUntitled({ path: browser()?.model.path ?? '', type: 'file', ext: '.dos' });
      documents.open(file.path, 'Editor');
    }, false);
    addCommand('run-dos', 'DolphinDB: 运行文件', () => runFile(editors.currentWidget!));
    addCommand('run-selection', 'DolphinDB: 运行选中代码或当前行', () => runSelection(editors.currentWidget!));
    addCommand('run-advance', 'DolphinDB: 运行并移至下一行', () => runSelection(editors.currentWidget!, true));
    addCommand('complete', 'DolphinDB: 代码提示', () => completer?.invoke(editors.currentWidget!.id));
    addCommand('batch-dos', 'DolphinDB: 批量运行 DOS 文件', batch, false);
    addCommand('stop-batch', 'DolphinDB: 停止后续批量运行', () => { stopBatch = true; }, false);
    addCommand('interrupt-dos', 'DolphinDB: 中断当前文件', () => active()?.interrupt());
    for (const [keys, command] of [[['Ctrl Enter'], 'run-selection'], [['Shift Enter'], 'run-advance'], [['Ctrl Shift Enter'], 'run-dos'], [['Ctrl Space'], 'complete']] as const) {
      app.commands.addKeyBinding({ keys: [...keys], selector: '.jp-FileEditor.ddb-dos-editor .cm-content', command: prefix + command });
    }
    launcher?.add({ command: prefix + 'new-dos', category: 'DolphinDB', rank: 1 });
    app.contextMenu.addItem({ command: prefix + 'new-dos', selector: '.jp-DirListing-content', rank: 90 });
    app.contextMenu.addItem({ command: prefix + 'batch-dos', selector: '.jp-DirListing-item[data-file-type="dolphindb"]', rank: 91 });
    app.contextMenu.addItem({ command: prefix + 'run-selection', selector: '.ddb-dos-editor .cm-content', rank: 1 });
    app.contextMenu.addItem({ command: prefix + 'run-dos', selector: '.ddb-dos-editor .cm-content', rank: 2 });
    running?.add({
      name: 'DolphinDB DOS 会话',
      runningChanged: manager.changed,
      running: () => manager.sessions.filter(s => s.locked).map(session => ({
        icon: () => DOS_ICON,
        label: () => session.path.split('/').pop()!,
        labelTitle: () => `${session.path}\n${session.profile.name} · ${session.state}`,
        detail: () => `${session.profile.name} · ${session.state === 'busy' ? '运行中' : session.state === 'disconnected' ? '已断开' : '空闲'}`,
        open: () => { documents.openOrReveal(session.path, 'Editor'); },
        shutdown: () => { void manager.shutdown(session.id); },
      })),
      refreshRunning: () => { void manager.refresh(); },
      shutdownAll: () => { void Promise.all(manager.sessions.filter(s => s.locked).map(s => manager.shutdown(s.id))); },
      shutdownLabel: '关闭会话', shutdownAllLabel: '关闭所有 DOS 会话',
      shutdownAllConfirmationText: '关闭所有 DOS 会话？会话变量将被释放，DOS 文件内容会保留。',
    });
    return manager;
  },
} satisfies JupyterFrontEndPlugin<DosManager>;
