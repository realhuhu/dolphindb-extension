import * as React from 'react';
import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ILabShell } from '@jupyterlab/application';
import { ICommandPalette, InputDialog, ReactWidget, showDialog } from '@jupyterlab/apputils';
import { IEditorLanguageRegistry } from '@jupyterlab/codemirror';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IDocumentWidget } from '@jupyterlab/docregistry';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { FileEditor, IEditorTracker } from '@jupyterlab/fileeditor';
import { ILauncher } from '@jupyterlab/launcher';
import { IRunningSessionManagers } from '@jupyterlab/running';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { LabIcon } from '@jupyterlab/ui-components';
import { DisposableDelegate } from '@lumino/disposable';
import { BoxPanel, SplitPanel, StackedLayout } from '@lumino/widgets';
import { IConnectionModel } from '../tokens';
import type { ConnectionModel } from '../model';
import { DosManager, type DosModel } from './model';
import { DOS_MIME, languageSupport } from './language';
import { ILanguageEditors } from '../language/plugin';
import type { LanguageEditors } from '../language/editor';
import { dosMetadata } from '../language/metadata';
import { projection } from '../language/regions';
import { createDosToolbar, OutputPanel } from './views';
import { registerDdbRenderer } from './output';
import { ISessionWorkspace, type SessionWorkspace } from '../session/workspace';
import { captureVariableInsertion } from '../session/interactions';

const DOS_ICON = new LabIcon({ name: 'dolphindb-extension:dos', svgstr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path class="jp-icon3" fill="#616161" d="M5 2h9l5 5v15H5zm9 2v5h5L14 4zM7 12v6h3c3 0 3-6 0-6zm2 2h1c1 0 1 2 0 2H9zm5-2h-2v6h2c4 0 4-6 0-6zm0 2c2 0 2 2 0 2z"/></svg>' });
const prefix = 'dolphindb-extension:';
type EditorWidget = IDocumentWidget<FileEditor>;

export default {
  id: `${prefix}dos`, autoStart: true,
  requires: [IConnectionModel, IEditorTracker, IDocumentManager, IEditorLanguageRegistry, ILanguageEditors, ISessionWorkspace, IRenderMimeRegistry],
  optional: [ICommandPalette, IRunningSessionManagers, ILauncher, IFileBrowserFactory, ILabShell],
  activate: (app: JupyterFrontEnd, connections: ConnectionModel, editors: IEditorTracker, documents: IDocumentManager, languages: IEditorLanguageRegistry, languageEditors: LanguageEditors, workspace: SessionWorkspace, rendermime: IRenderMimeRegistry,
    palette: ICommandPalette | null, running: IRunningSessionManagers | null, launcher: ILauncher | null, browsers: IFileBrowserFactory | null, labShell: ILabShell | null) => {
    const manager = new DosManager(connections);
    registerDdbRenderer(rendermime);
    if (!languages.findByMIME(DOS_MIME)) {
      languages.addLanguage({ name: 'DolphinDB', mime: DOS_MIME, extensions: ['dos'], load: async () => languageSupport() });
    }
    app.docRegistry.addFileType({ name: 'dolphindb', displayName: 'DolphinDB', extensions: ['.dos'], mimeTypes: [DOS_MIME], fileFormat: 'text', contentType: 'file', icon: DOS_ICON });
    const models = new Map<EditorWidget, DosModel>();
    const active = () => models.get(app.shell.currentWidget as EditorWidget) ?? null;
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
      const choices = paths.map((path, index) => ({ path, label: `${index + 1}. ${path} · ${manager.profileFor(path)?.name ?? '未选择连接'}` }));
      const result = await InputDialog.getMultipleItems({ title: '批量运行 DOS',
        label: '按列表顺序执行，各文件使用自己的会话；遇到错误停止。Ctrl / Shift 可多选。',
        items: choices.map(item => item.label), defaults: choices.map(item => item.label), okLabel: '运行所选文件', cancelLabel: '取消' });
      if (!result.button.accept || !result.value?.length) { return; }
      batchRunning = true; stopBatch = false;
      try {
        const jobs: { model: DosModel; code: string; widget: EditorWidget }[] = [];
        for (const { path } of choices.filter(item => result.value!.includes(item.label))) {
          const widget = documents.openOrReveal(path, 'Editor') as EditorWidget;
          await widget.context.ready;
          jobs.push({ model: manager.document(path), code: getSource(widget), widget });
        }
        for (const job of jobs) {
          if (stopBatch) { break; }
          app.shell.activateById(job.widget.id);
          workspace.sync(true);
          if (!await job.model.run(job.code)) { break; }
        }
      } finally { batchRunning = false; }
    };

    app.docRegistry.addWidgetExtension('Editor', {
      createNew(widget: EditorWidget, context) {
        if (!context.path.toLowerCase().endsWith('.dos')) { return new DisposableDelegate(() => {}); }
        const model = manager.document(context.path);
        const unbindLanguage = languageEditors.bind(widget.content.editor.model, {
          path: () => context.path, source: () => getSource(widget), project: (source, offset) => projection(source, offset, true),
          metadata: dosMetadata(model), identity: () => `${model.profile?.id}:${model.session?.id ?? 'preview'}:${model.session?.executionCount ?? 0}`,
          open: async (uri, range) => {
            const target = documents.openOrReveal(uri, 'Editor') as EditorWidget | undefined;
            if (!target) { return; } await target.context.ready;
            target.content.editor.setSelection({ start: { line: range.start.line, column: range.start.character }, end: { line: range.end.line, column: range.end.character } });
            target.content.editor.focus();
          },
        });
        models.set(widget, model);
        model.open();
        const isCurrent = () => !widget.isDisposed && app.shell.currentWidget === widget;
        const workspaceBinding = workspace.register(widget, {
          model, path: () => context.path, scope: 'file', isCurrent,
          identity: () => `${model.profile?.id}:${model.session?.id ?? 'preview'}:${model.session?.executionCount ?? 0}`,
          captureInsertion: name => captureVariableInsertion(widget.content.editor, name, isCurrent),
        });
        widget.content.addClass('ddb-dos-editor');
        widget.title.icon = DOS_ICON;
        const layout = widget.content.layout as StackedLayout;
        const code = layout.widgets[0];
        code.parent = null;
        const split = new SplitPanel({ orientation: 'vertical', spacing: 4 });
        split.addClass('ddb-editor-split');
        split.addWidget(code);
        const output = ReactWidget.create(<OutputPanel model={model} rendermime={rendermime}/>);
        output.addClass('ddb-output-widget');
        split.addWidget(output);
        split.setRelativeSizes([0.7, 0.3]);
        layout.addWidget(split);
        const toolbar = createDosToolbar({ model, runFile: () => runFile(widget), runSelection: () => runSelection(widget), batch, showWorkspace: () => workspace.sync(true) });
        toolbar.addClass('ddb-toolbar-widget');
        split.parent = null;
        const body = new BoxPanel({ direction: 'top-to-bottom', spacing: 0 });
        body.addClass('ddb-editor-body');
        body.addWidget(toolbar);
        body.addWidget(split);
        BoxPanel.setStretch(split, 1);
        layout.addWidget(body);
        const renamed = () => { void model.rename(context.path); };
        context.pathChanged.connect(renamed);
        void context.ready.then(() => {
          if (widget.isDisposed || app.shell.currentWidget !== widget) { return; }
          if (app.shell.node.clientWidth < 1100) { labShell?.collapseLeft(); }
          workspace.sync(true);
        });
        return new DisposableDelegate(() => {
          unbindLanguage();
          context.pathChanged.disconnect(renamed);
          models.delete(widget);
          model.closeView();
          workspaceBinding.dispose();
        });
      },
    });

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
    addCommand('complete', 'DolphinDB: 代码提示', () => languageEditors.complete(editors.currentWidget!.content.editor.model));
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
