import * as React from 'react';
import { Debugger, type IDebugger } from '@jupyterlab/debugger';
import { Callstack } from '@jupyterlab/debugger/lib/panels/callstack';
import { VariablesBodyTree } from '@jupyterlab/debugger/lib/panels/variables/tree';
import { VariablesBodyGrid } from '@jupyterlab/debugger/lib/panels/variables/grid';
import { VariablesModel } from '@jupyterlab/debugger/lib/panels/variables/model';
import { BreakpointsBody } from '@jupyterlab/debugger/lib/panels/breakpoints/body';
import type { IThemeManager } from '@jupyterlab/apputils';
import { ReactWidget } from '@jupyterlab/apputils';
import type { IEditorServices, CodeEditorWrapper } from '@jupyterlab/codeeditor';
import { CommandToolbarButton, HTMLSelect, PanelWithToolbar, SidePanel, ToolbarButton, treeViewIcon, tableRowsIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';
import { DosDebugSession, type DebugFrame } from './session';
import { DebugEditor } from './editor';
import type { DebugVariable } from './remote';
import { debugIcon, clearIcon, previewIcon, openIcon, exceptionIcon } from '../icons';
import { formatBytes } from '../session/variables';
import { objectPage } from '../data/sdk';
import type { DataBrowser } from '../data/plugin';
import { DOS_MIME } from '../dos/language';

export const debugCommands = {
  start: 'dolphindb-extension:debug-start', resume: 'dolphindb-extension:debug-continue', stop: 'dolphindb-extension:debug-stop',
  next: 'dolphindb-extension:debug-next', stepIn: 'dolphindb-extension:debug-step-in', stepOut: 'dolphindb-extension:debug-step-out',
  restart: 'dolphindb-extension:debug-restart', toggle: 'dolphindb-extension:debug-breakpoint',
  show: 'dolphindb-extension:debug-show',
};
const stateLabel = (session: DosDebugSession | null) => !session ? '打开 DOS 文件以开始调试' : ({ idle: '尚未调试', starting: '正在启动', running: '运行中', paused: session.reason, stopping: '正在停止', ended: session.reason || '已结束' })[session.state];
const variableText = (v: DebugVariable): string => v.offset === -1 ? `数据过大（${formatBytes(String(v.bytes ?? 0))}）`
  : v.ddbValue ? v.ddbValue.toString().slice(0, 1000) : v.data !== undefined ? String(v.data) : `${v.form}<${v.type}> [${v.rows ?? 0} × ${v.columns ?? 1}] · ${formatBytes(String(v.bytes ?? 0))}`;

class CallbackWidget extends ReactWidget {
  constructor(private view: () => React.ReactElement) { super(); }
  render(): React.ReactElement { return this.view(); }
}

/** Native Jupyter debugger models/panels, with a private command registry for variables.
 * This never uses the global kernel debugger service or its Notebook commands. */
export class DebugPanel extends SidePanel {
  readonly model = new Debugger.Model();
  private treeModel = new VariablesModel();
  session: DosDebugSession | null = null;
  private status: ReactWidget;
  private output = new Widget({ node: document.createElement('pre') });
  private exceptions: ToolbarButton;
  private clear: ToolbarButton;
  private editor: CodeEditorWrapper;
  private editorHandler: DebugEditor | null = null;
  private sourcePath = '';
  private previewVersion = 0;
  private displayedFrame: DebugFrame | null = null;
  private lastBreaks = '';
  private rawFrames: DebugFrame[] | null = null;
  private rawVariables: DebugVariable[] | null = null;
  private syncing = false;
  private references = new Map<number, DebugVariable>();
  private nextReference = 1;
  private sourcePanel = new PanelWithToolbar();

  constructor(private options: {
    commands: CommandRegistry; editorServices: IEditorServices; themeManager: IThemeManager | null; browser: DataBrowser;
    sessions: () => DosDebugSession[]; select: (session: DosDebugSession) => void;
    open: (session: DosDebugSession, path: string, line?: number) => Promise<void>; save: () => void;
  }) {
    super(); this.id = 'dolphindb-debugger'; this.title.icon = debugIcon; this.title.caption = 'DolphinDB 调试（仅 DOS）';
    this.addClass('jp-DebuggerSidebar'); this.addClass('ddb-debug-sidebar');
    this.node.setAttribute('aria-label', 'DolphinDB 调试');
    const commands = options.commands;
    this.status = new CallbackWidget(() => this.renderStatus()); this.header.addWidget(this.status);
    this.toolbar.addItem('start', new CommandToolbarButton({ commands, id: debugCommands.start, args: { fromSidebar: true }, label: '调试 DOS' }));
    this.toolbar.addItem('restart', new CommandToolbarButton({ commands, id: debugCommands.restart, label: '' }));

    const callstack = new Callstack({ model: this.model.callstack, commands: {
      registry: commands, continue: debugCommands.resume, terminate: debugCommands.stop, next: debugCommands.next,
      stepIn: debugCommands.stepIn, stepOut: debugCommands.stepOut, evaluate: debugCommands.restart,
    } });
    // DolphinDB's debugger has no evaluate/watch RPC. Restart lives in the main toolbar.
    [...callstack.toolbar.children()][[...callstack.toolbar.names()].indexOf('evaluate')]?.dispose();
    callstack.title.label = '调用栈';
    const privateCommands = new CommandRegistry();
    privateCommands.addCommand(Debugger.CommandIDs.renderMimeVariable, { label: '预览调试变量', icon: previewIcon,
      isEnabled: () => Boolean(this.session?.paused), execute: args => this.previewVariable(String(args.name)) });
    privateCommands.addCommand(Debugger.CommandIDs.inspectVariable, { label: '预览调试变量',
      isEnabled: () => Boolean(this.session?.paused), execute: args => this.previewVariable(String(args.name)) });
    privateCommands.addCommand(Debugger.CommandIDs.copyToClipboard, { label: '复制变量值',
      execute: () => navigator.clipboard.writeText(this.model.variables.selectedVariable?.value ?? this.treeModel.selectedVariable?.value ?? '') });
    // Variables currently consumes exactly these two members of the broad IDebugger
    // interface. Keep the bridge local so no kernel/session implementation is exposed.
    const variableService: Pick<IDebugger, 'model' | 'inspectVariable'> = { model: this.model, inspectVariable: reference => this.inspect(reference) };
    const tree = new VariablesBodyTree({ model: this.treeModel, service: variableService as IDebugger, commands: privateCommands });
    const grid = new VariablesBodyGrid({ model: this.model.variables, commands: privateCommands, themeManager: options.themeManager });
    const variables = new class extends PanelWithToolbar {
      protected onResize(message: Widget.ResizeMessage): void {
        super.onResize(message); tree.node.style.height = `${Math.max(0, message.height - this.toolbar.node.offsetHeight)}px`;
      }
    }();
    variables.title.label = '调试变量'; variables.addClass('jp-DebuggerVariables'); this.model.hasRichVariableRendering = true;
    variables.addWidget(tree); variables.addWidget(grid); grid.hide();
    const treeButton = new ToolbarButton({ icon: treeViewIcon, tooltip: 'Tree View', onClick: () => switchView(false) });
    const gridButton = new ToolbarButton({ icon: tableRowsIcon, tooltip: 'Table View', onClick: () => switchView(true) });
    const switchView = (table: boolean) => { tree.setHidden(table); grid.setHidden(!table); treeButton.pressed = !table; gridButton.pressed = table; variables.update(); };
    variables.toolbar.addItem('tree', treeButton); variables.toolbar.addItem('grid', gridButton); switchView(false);
    const breakpoints = new PanelWithToolbar(); breakpoints.title.label = '断点'; breakpoints.addClass('jp-DebuggerBreakpoints');
    breakpoints.addWidget(new BreakpointsBody(this.model.breakpoints));
    this.exceptions = new ToolbarButton({ icon: exceptionIcon, tooltip: '遇到异常时暂停', onClick: () => { if (this.session) { void this.session.setExceptions(!this.session.exceptions); this.options.save(); } } });
    this.clear = new ToolbarButton({ icon: clearIcon, tooltip: '移除当前 DOS 的所有断点', onClick: () => {
      if (!this.session) { return; }
      for (const path of this.session.breaks.keys()) { void this.session.setBreakpoints(path, []); }
      this.options.save();
    } });
    breakpoints.toolbar.addItem('exceptions', this.exceptions); breakpoints.toolbar.addItem('clear', this.clear);
    this.model.breakpoints.clicked.connect((_, point) => { if (this.session && point.source?.path) { void this.options.open(this.session, point.source.path, (point.line ?? 1) - 1); } });
    this.model.callstack.currentFrameChanged.connect((_, frame) => {
      if (this.syncing || !frame || !this.session) { return; }
      const raw = this.session.frames.find(value => value.stackFrameId === frame.id);
      if (raw && raw !== this.session.frame) { void this.session.selectFrame(raw); }
    });
    this.editor = new Debugger.ReadOnlyEditorFactory({ editorServices: options.editorServices }).createNewEditor({ content: '', mimeType: DOS_MIME, path: '' });
    this.editor.hide();
    this.sourcePanel.title.label = '源码'; this.sourcePanel.addClass('ddb-debug-source');
    this.sourcePanel.toolbar.addItem('open', new ToolbarButton({ icon: openIcon, tooltip: '在主区域查看源码', onClick: () => { if (this.session && this.sourcePath) { void this.options.open(this.session, this.sourcePath, this.session.frame?.line); } } }));
    this.sourcePanel.addWidget(this.editor);
    const output = new PanelWithToolbar(); output.title.label = '调试输出'; output.addClass('ddb-debug-output');
    this.output.node.setAttribute('aria-label', '调试输出'); output.addWidget(this.output);
    output.toolbar.addItem('clear', new ToolbarButton({ icon: clearIcon, tooltip: '清空调试输出', onClick: () => { if (this.session) { this.session.output = ''; this.session.changed.emit(); } } }));
    this.addWidget(variables); this.addWidget(callstack); this.addWidget(breakpoints); this.addWidget(this.sourcePanel); this.addWidget(output);
    this.sync();
  }
  setSession(session: DosDebugSession | null): void {
    if (session === this.session) { this.sync(); return; }
    this.session?.changed.disconnect(this.sync, this); this.session = session;
    this.rawFrames = null; this.rawVariables = null; this.sourcePath = ''; this.displayedFrame = null; this.editorHandler?.dispose(); this.editorHandler = null;
    ++this.previewVersion; this.editor.hide();
    session?.changed.connect(this.sync, this); this.sync();
  }
  refresh(): void { this.sync(); }
  private renderStatus(): React.ReactElement {
    const session = this.session;
    return <div className="ddb-debug-status">
      <strong>DolphinDB 调试</strong>
      <HTMLSelect aria-label="DOS 调试文件" value={session?.id ?? ''} disabled={!session} onChange={event => {
        const selected = this.options.sessions().find(s => s.id === event.target.value); if (selected) { this.options.select(selected); }
      }}><option value="" disabled>选择 DOS 文件</option>{this.options.sessions().map(s => <option key={s.id} value={s.id}>{s.path} · {stateLabel(s)}</option>)}</HTMLSelect>
      <div className="ddb-debug-state" role="status"><span>{stateLabel(session)}</span><span>{session?.profile?.name ?? ''}</span></div>
      {!session && <p className="ddb-muted">仅支持 .dos 文件。点击行号左侧设置断点，按 F5 开始调试。</p>}
      {session?.error && <p className="ddb-panel-error" role="alert">{session.error}</p>}
    </div>;
  }
  private sync(): void {
    const session = this.session;
    this.status.update();
    this.exceptions.enabled = Boolean(session) && !session!.pending; this.exceptions.pressed = session?.exceptions ?? false;
    this.clear.enabled = Boolean(session && [...session.breaks.values()].some(p => p.length));
    const breaks = new Map<string, IDebugger.IBreakpoint[]>();
    for (const [path, points] of session?.breaks ?? []) { if (points.length) { breaks.set(path, points.map(p => ({ line: p.line + 1, verified: p.verified, source: { path, name: path.split('/').pop() } }))); } }
    const signature = JSON.stringify([...breaks]);
    if (signature !== this.lastBreaks) { this.lastBreaks = signature; this.model.breakpoints.restoreBreakpoints(breaks); }
    this.syncing = true;
    try {
      if (this.rawFrames !== (session?.frames ?? null)) {
        this.rawFrames = session?.frames ?? null;
        this.model.callstack.frames = session?.frames.map(frame => ({ id: frame.stackFrameId, name: frame.name || (frame.moduleName === undefined ? '共享作用域' : `第 ${frame.line + 1} 行`),
          line: frame.line + 1, column: (frame.column ?? 0) + 1, source: { path: session.sourcePath(frame.moduleName), name: frame.moduleName || session.path.split('/').pop() } })) ?? [];
      }
      const frame = this.model.callstack.frames.find(f => f.id === session?.frame?.stackFrameId) ?? null;
      if (this.model.callstack.frame !== frame) { this.model.callstack.frame = frame; }
      if (this.rawVariables !== (session?.variables ?? null)) {
        this.rawVariables = session?.variables ?? null; this.references.clear();
        this.model.variables.scopes = session?.paused && session.frame ? [{ name: `栈帧 ${session.frame.stackFrameId}`, variables: session.variables.map(v => {
          const reference = this.nextReference++; this.references.set(reference, v);
          return { name: v.name, evaluateName: v.name, type: v.form === 'SCALAR' ? v.type : `${v.form}<${v.type}>`, value: variableText(v), variablesReference: v.offset === -1 || v.form === 'SCALAR' ? 0 : reference };
        }) }] : [];
        // The native tree uses `type` as its detail for non-Python types. Keep that
        // presentation adaptation separate so the native grid shows real DDB types.
        this.treeModel.scopes = this.model.variables.scopes.map(scope => ({ ...scope, variables: scope.variables.map(v => ({ ...v, type: `${v.type} · ${v.value}` })) }));
      }
    } finally { this.syncing = false; }
    const text = session?.output ?? '';
    if (this.output.node.textContent !== text) { this.output.node.textContent = text; this.output.node.scrollTop = this.output.node.scrollHeight; }
    if (this.displayedFrame !== (session?.frame ?? null)) { this.displayedFrame = session?.frame ?? null; void this.showSource(); }
  }
  private async showSource(): Promise<void> {
    const session = this.session, frame = session?.frame, version = ++this.previewVersion;
    if (!session || !frame) { this.editor.hide(); return; }
    const path = session.sourcePath(frame.moduleName);
    try {
      const content = await session.source(path);
      if (version !== this.previewVersion || this.session !== session || session.frame !== frame) { return; }
      if (path !== this.sourcePath || content !== this.editor.model.sharedModel.getSource()) {
        this.editorHandler?.dispose(); this.editorHandler = null;
        this.sourcePath = path; this.editor.model.sharedModel.setSource(content);
        this.editorHandler = new DebugEditor(this.editor.editor, session, () => this.sourcePath, this.options.save);
      }
      this.sourcePanel.title.caption = path; this.editor.show(); this.editorHandler?.sync(); this.editorHandler?.reveal(frame.line);
    } catch (error) { if (version === this.previewVersion) { session.report(error); } }
  }
  private async inspect(reference: number): Promise<IDebugger.IVariable[]> {
    const session = this.session, variable = this.references.get(reference);
    if (!session || !variable) { return []; }
    try {
      const value = await session.variable(variable);
      if (session !== this.session || !session.paused || !session.variables.includes(variable)) { return []; }
      return [{ name: '值', value: variableText(value), type: variableText(value), variablesReference: 0 }];
    } catch (error) { session.report(error); return []; }
  }
  private async previewVariable(name: string): Promise<void> {
    const session = this.session, variable = session?.variables.find(v => v.name === name);
    if (!session || !variable) { return; }
    const frame = session.frame;
    try {
      const value = await session.value(variable);
      if (session !== this.session || !session.paused || session.frame !== frame || !session.variables.includes(variable)) { return; }
      if (!value) { session.report(variableText(await session.variable(variable))); return; }
      this.options.browser.open({ title: `${session.path.split('/').pop()} · ${name}（调试快照）`, read: async request => objectPage(value, request) });
    } catch (error) { session.report(error); }
  }
}
