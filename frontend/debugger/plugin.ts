import { ILabShell, ILayoutRestorer, type JupyterFrontEnd, type JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ICommandPalette, IThemeManager, MainAreaWidget, showErrorMessage } from '@jupyterlab/apputils';
import { IEditorServices, type CodeEditorWrapper } from '@jupyterlab/codeeditor';
import { IDocumentManager } from '@jupyterlab/docmanager';
import type { IDocumentWidget } from '@jupyterlab/docregistry';
import { FileEditor, IEditorTracker } from '@jupyterlab/fileeditor';
import { IRunningSessionManagers } from '@jupyterlab/running';
import { IStateDB } from '@jupyterlab/statedb';
import { Debugger } from '@jupyterlab/debugger';
import { Signal } from '@lumino/signaling';
import { request, socketUrl, type SessionTicket } from '../api';
import { IDosManager } from '../tokens';
import type { DosManager, DosModel } from '../dos/model';
import { IDataBrowser, type DataBrowser } from '../data/plugin';
import { debugIcon, runIcon, pauseIcon, stopIcon, refreshIcon } from '../icons';
import { DOS_MIME } from '../dos/language';
import { DosDebugSession, type DebugSource } from './session';
import { DebugEditor } from './editor';
import { DebugPanel, debugCommands as ids } from './panel';

type EditorWidget = IDocumentWidget<FileEditor>;
const stateKey = 'dolphindb-extension:dos-debugger';
interface SavedDebug { [path: string]: { lines: number[]; exceptions: boolean }; }

export default {
  id: 'dolphindb-extension:debugger', autoStart: true,
  requires: [IDosManager, IEditorTracker, IDocumentManager, IEditorServices, IDataBrowser],
  optional: [ICommandPalette, ILayoutRestorer, ILabShell, IRunningSessionManagers, IThemeManager, IStateDB],
  activate: (app: JupyterFrontEnd, dos: DosManager, editors: IEditorTracker, documents: IDocumentManager, editorServices: IEditorServices, browser: DataBrowser,
    palette: ICommandPalette | null, restorer: ILayoutRestorer | null, labShell: ILabShell | null, running: IRunningSessionManagers | null, themeManager: IThemeManager | null, state: IStateDB | null) => {
    const sessions = new Map<DosModel, DosDebugSession>();
    const bindings = new Map<EditorWidget, { session: DosDebugSession; handler: DebugEditor; readOnly?: boolean }>();
    const sourceWidgets = new Map<string, { widget: MainAreaWidget<CodeEditorWrapper>; session: DosDebugSession; source: DebugSource }>();
    const changed = new Signal<object, void>(sessions);
    let saved: SavedDebug = {}, saveTimer: ReturnType<typeof setTimeout> | undefined;
    const ready = state?.fetch(stateKey).then(value => {
      if (value && typeof value === 'object' && !Array.isArray(value)) { saved = value as unknown as SavedDebug; }
    }).catch(() => {}) ?? Promise.resolve();
    const save = () => {
      for (const session of sessions.values()) { saved[session.path] = { lines: (session.breaks.get(session.path) ?? []).map(p => p.line), exceptions: session.exceptions }; }
      if (saveTimer) { clearTimeout(saveTimer); }
      saveTimer = setTimeout(() => { void state?.save(stateKey, saved as any).catch(() => {}); }, 200);
    };
    const activeWidget = () => {
      const widget = app.shell.currentWidget as EditorWidget;
      return bindings.has(widget) && widget.context.path.toLowerCase().endsWith('.dos') ? widget : null;
    };
    const active = () => { const widget = activeWidget(); return widget ? bindings.get(widget)!.session : null; };
    const modelFor = (session: DosDebugSession) => [...sessions].find(([, value]) => value === session)?.[0];
    const editorFor = (session: DosDebugSession) => {
      const current = activeWidget();
      return current && bindings.get(current)?.session === session ? current : [...bindings].find(([widget, binding]) =>
        !widget.isDisposed && widget.context.path.toLowerCase().endsWith('.dos') && binding.session === session)?.[0];
    };
    const notify = () => { for (const id of Object.values(ids)) { if (app.commands.hasCommand(id)) { app.commands.notifyCommandChanged(id); } } changed.emit(); };
    const report = (promise: Promise<unknown>) => { void promise.catch(error => showErrorMessage('DolphinDB 调试', error)); };
    const open = async (session: DosDebugSession, path: string, line = 0) => {
      panel.setSession(session);
      if (path === session.path) {
        const widget = documents.openOrReveal(path, 'Editor') as EditorWidget;
        await widget.context.ready; await bind(widget);
        app.shell.activateById(widget.id); bindings.get(widget)?.handler.reveal(line); return;
      }
      const source = session.sources.get(path);
      if (!source) { return; }
      const content = await session.source(path);
      if (session.sources.get(path) !== source || source.content !== content) { return; }
      let widget = sourceWidgets.get(path)?.widget;
      if (!widget || widget.isDisposed) {
        const editor = new Debugger.ReadOnlyEditorFactory({ editorServices }).createNewEditor({ content, mimeType: DOS_MIME, path });
        widget = new MainAreaWidget({ content: editor }); widget.id = `ddb-debug-source-${crypto.randomUUID()}`;
        widget.title.label = path.split('/').pop()!; widget.title.caption = `调试源码 · ${path}`; widget.title.icon = debugIcon;
        const handler = new DebugEditor(editor.editor, session, () => path, save);
        widget.disposed.connect(() => { handler.dispose(); if (sourceWidgets.get(path)?.widget === widget) { sourceWidgets.delete(path); } });
        sourceWidgets.set(path, { widget, session, source }); app.shell.add(widget, 'main');
      }
      app.shell.activateById(widget.id);
      if (line >= 0 && line < widget.content.editor.lineCount) { widget.content.editor.setCursorPosition({ line, column: 0 }); widget.content.editor.revealPosition({ line, column: 0 }); }
    };
    const panel = new DebugPanel({ commands: app.commands, editorServices, themeManager, browser, sessions: () => [...sessions.values()], select: session => { panel.setSession(session); notify(); }, open, save });
    // Follow the database/variables panel (rank 600) in the right sidebar.
    app.shell.add(panel, 'right', { rank: 610 }); restorer?.add(panel, 'dolphindb-debugger');
    const show = () => app.shell.activateById(panel.id);
    const start = async (session: DosDebugSession | null) => {
      const widget = session && editorFor(session), model = session && modelFor(session);
      if (!widget || !session || !model || model.executing || model.loading || model.pathError) { return; }
      app.shell.activateById(widget.id);
      panel.setSession(session); show();
      if (session.paused) { await session.control('continueRun'); return; }
      if (session.active) { return; }
      if (!model.profile) { throw new Error('请先为此 DOS 文件选择 DolphinDB 连接。'); }
      await session.start(model.profile);
    };
    const selected = () => panel.session;
    const add = (id: string, label: string, execute: () => unknown, enabled: () => boolean, icon?: typeof debugIcon) => {
      app.commands.addCommand(id, { label, execute, isEnabled: enabled, icon }); palette?.addItem({ command: id, category: 'DolphinDB 调试' });
    };
    app.commands.addCommand(ids.start, {
      label: 'DolphinDB: 开始调试 DOS', icon: debugIcon,
      execute: args => start(args.fromSidebar === true ? selected() : active()),
      isEnabled: args => {
        const session = args.fromSidebar === true ? selected() : active(), model = session && modelFor(session);
        return Boolean(session && editorFor(session) && model?.profile && !model.executing && !model.loading && !model.pathError && !session.pending && (!session.active || session.paused));
      },
    });
    palette?.addItem({ command: ids.start, category: 'DolphinDB 调试' });
    app.commands.addCommand(ids.resume, { label: () => selected()?.paused ? '继续（F5）' : '暂停', icon: () => selected()?.paused ? runIcon : pauseIcon,
      isEnabled: () => Boolean(selected()?.active && !selected()?.pending), execute: () => selected()?.control(selected()?.paused ? 'continueRun' : 'pauseRun') });
    add(ids.stop, '停止调试（Shift + F5）', () => selected()?.stop(), () => Boolean(selected()?.active), stopIcon);
    add(ids.next, '逐过程（F10）', () => selected()?.control('stepOver'), () => Boolean(selected()?.paused && !selected()?.pending), Debugger.Icons.stepOverIcon);
    add(ids.stepIn, '单步进入（F11）', () => selected()?.control('stepInto'), () => Boolean(selected()?.paused && !selected()?.pending), Debugger.Icons.stepIntoIcon);
    add(ids.stepOut, '单步跳出（Shift + F11）', () => selected()?.control('stepOut'), () => Boolean(selected()?.paused && !selected()?.pending), Debugger.Icons.stepOutIcon);
    add(ids.restart, '重新调试（Ctrl + Shift + F5）', async () => {
      const session = selected(); if (!session) { return; }
      const model = modelFor(session)!; await session.stop();
      if (model.profile && !model.executing && !model.pathError) { await session.start(model.profile); }
    }, () => Boolean(selected()?.active && !selected()?.pending), refreshIcon);
    add(ids.toggle, '切换 DOS 断点（F9）', () => { const widget = activeWidget(); if (widget) { bindings.get(widget)!.handler.toggle(); } }, () => Boolean(active()), debugIcon);
    add(ids.show, 'DolphinDB: 显示调试面板', show, () => true, debugIcon);
    for (const [keys, command] of [[['F5'], ids.start], [['F9'], ids.toggle], [['F10'], ids.next], [['F11'], ids.stepIn], [['Shift F11'], ids.stepOut], [['Shift F5'], ids.stop], [['Ctrl Shift F5'], ids.restart]] as const) {
      app.commands.addKeyBinding({ keys: [...keys], command, selector: '.ddb-dos-editor .cm-content' });
    }
    app.contextMenu.addItem({ command: ids.start, selector: '.ddb-dos-editor .cm-content', rank: 3 });
    app.contextMenu.addItem({ command: ids.toggle, selector: '.ddb-dos-editor .cm-content', rank: 4 });

    const bindingPromises = new Map<EditorWidget, Promise<void>>();
    function bind(widget: EditorWidget): Promise<void> {
      if (bindings.has(widget)) { return Promise.resolve(); }
      const existing = bindingPromises.get(widget); if (existing) { return existing; }
      const promise = (async () => {
        await widget.context.ready; await ready;
        if (widget.isDisposed || !widget.context.path.toLowerCase().endsWith('.dos')) { return; }
        const model = dos.document(widget.context.path);
        let session = sessions.get(model);
        if (!session) {
          session = new DosDebugSession(model.path, {
            source: () => [...bindings].find(([, b]) => b.session === session)?.[0].content.model.sharedModel.getSource() ?? '',
            ticket: () => model.session
              ? request<SessionTicket>(`dos-sessions/${model.session.id}/control`, 'POST')
              : request<SessionTicket>('sessions', 'POST', { id: session!.profile?.id }),
            url: socketUrl,
            locked: active => {
              model.debugging = active; model.changed.emit();
              if (!active) { void model.useDefault(); }
              for (const [view, binding] of bindings) {
                if (binding.session !== session || view.isDisposed) { continue; }
                if (active) { binding.readOnly = Boolean(view.content.editor.getOption('readOnly')); view.content.editor.setOption('readOnly', true); }
                else if (binding.readOnly !== undefined) { view.content.editor.setOption('readOnly', binding.readOnly); binding.readOnly = undefined; }
              }
            },
          });
          // Publish the document's session before awaiting restored breakpoints so
          // concurrently restored editor views all bind to the same instance.
          sessions.set(model, session);
          session.changed.connect(() => {
            // Sources belong to one parsed program and connection. Read-only
            // module windows from an earlier run must not retain live gutters.
            for (const [path, view] of sourceWidgets) {
              if (view.session === session && session!.sources.get(path) !== view.source) { view.widget.dispose(); }
            }
            notify();
          });
          const snapshot = saved[session.path];
          if (snapshot && Array.isArray(snapshot.lines)) { session.exceptions = snapshot.exceptions === true; await session.setBreakpoints(session.path, snapshot.lines.filter(Number.isSafeInteger)); }
        }
        const handler = new DebugEditor(widget.content.editor, session, () => widget.context.path, save);
        const binding = { session, handler, readOnly: undefined as boolean | undefined };
        bindings.set(widget, binding);
        const focused = () => { panel.setSession(session!); notify(); };
        widget.content.node.addEventListener('focusin', focused);
        if (session.active) { binding.readOnly = Boolean(widget.content.editor.getOption('readOnly')); widget.content.editor.setOption('readOnly', true); }
        const renamed = () => {
          const previous = session!.path;
          void session!.stop().then(() => {
            if (session!.path === widget.context.path) { return; }
            const points = session!.breaks.get(previous) ?? [];
            session!.breaks.delete(previous); session!.sources.delete(previous);
            session!.path = widget.context.path;
            session!.sources.set(session!.path, { path: session!.path, module: '' });
            void session!.setBreakpoints(session!.path, points.map(p => p.line)); delete saved[previous]; save(); notify();
          });
        };
        widget.context.pathChanged.connect(renamed);
        widget.disposed.connect(() => {
          handler.dispose(); bindings.delete(widget); widget.context.pathChanged.disconnect(renamed);
          widget.content.node.removeEventListener('focusin', focused);
          if (![...bindings.values()].some(b => b.session === session)) { void session!.stop(); }
          notify();
        });
        model.changed.connect(notify);
        if (app.shell.currentWidget === widget) { panel.setSession(session); }
        panel.refresh(); notify();
      })().finally(() => bindingPromises.delete(widget));
      bindingPromises.set(widget, promise); return promise;
    }
    editors.widgetAdded.connect((_, widget) => report(bind(widget)));
    editors.forEach(widget => report(bind(widget)));
    const focus = () => { const session = active(); if (session) { panel.setSession(session); } notify(); };
    (labShell?.currentChanged ?? editors.currentChanged).connect(focus);
    running?.add({ name: 'DolphinDB 调试会话', runningChanged: changed,
      running: () => [...sessions.values()].filter(s => s.active).map(session => ({
        icon: () => debugIcon, label: () => session.path.split('/').pop()!, labelTitle: () => session.path,
        detail: () => `${session.profile?.name ?? ''} · ${stateLabel(session)}`,
        open: () => { panel.setSession(session); report(open(session, session.path, session.frame?.line)); show(); }, shutdown: () => report(session.stop()),
      })), refreshRunning: notify, shutdownAll: () => report(Promise.all([...sessions.values()].map(s => s.stop()))),
      shutdownLabel: '停止调试', shutdownAllLabel: '停止所有 DOS 调试', shutdownAllConfirmationText: '停止所有 DOS 调试会话？',
    });
    function stateLabel(session: DosDebugSession): string { return session.paused ? session.reason : session.state === 'running' ? '运行中' : '正在连接 / 停止'; }
  },
} satisfies JupyterFrontEndPlugin<void>;
