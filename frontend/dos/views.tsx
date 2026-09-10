import * as React from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { Accordion, AccordionItem, Toolbar as ReactToolbar, TreeItem, TreeView, type TreeItemElement } from '@jupyter/react-components';
import { runIcon, stopIcon, refreshIcon, clearIcon, spreadsheetIcon, FilterBox, SidePanel, PanelWithToolbar, ToolbarButton, ToolbarButtonComponent } from '@jupyterlab/ui-components';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { AccordionPanel } from '@lumino/widgets';
import type { DosModel } from './model';
import { NativeOutput } from './output';
import { SessionToolbar } from '../session/toolbar';
import type { WorkspaceBinding, WorkspaceModel } from '../session/types';
import { DebouncedActions } from '../session/interactions';

function useModel(model: Pick<WorkspaceModel, 'changed'>): void {
  const [, update] = React.useReducer(n => n + 1, 0);
  React.useEffect(() => { model.changed.connect(update); return () => { model.changed.disconnect(update); }; }, [model]);
}

export function OutputPanel({ model, rendermime }: { model: DosModel; rendermime: IRenderMimeRegistry }): React.ReactElement {
  useModel(model);
  const region = React.useRef<HTMLElement>(null);
  const following = React.useRef(false);
  const latest = model.outputs.at(-1);
  React.useLayoutEffect(() => {
    const parent = region.current?.parentElement;
    following.current = Boolean(latest);
    if (parent && latest) { parent.scrollTop = parent.scrollHeight; }
  }, [model.outputs.length, latest?.id, latest?.prints.length, latest?.value, latest?.error, latest?.status]);
  React.useLayoutEffect(() => {
    const parent = region.current?.parentElement;
    if (!parent) { return; }
    let visible = parent.clientWidth > 0 && parent.clientHeight > 0;
    // Inactive document tabs have no layout yet; follow restored output once revealed.
    const observer = new ResizeObserver(() => {
      const nextVisible = parent.clientWidth > 0 && parent.clientHeight > 0;
      if (nextVisible && !visible) { following.current = true; }
      visible = nextVisible;
      if (following.current && visible && model.outputs.length) { parent.scrollTop = parent.scrollHeight; }
    });
    observer.observe(parent);
    // MIME renderers finish asynchronously, after the enclosing React render.
    observer.observe(region.current!);
    return () => observer.disconnect();
  }, [model]);
  return <section ref={region} className="ddb-output" aria-label={`执行结果 ${model.path}`}>
    <ReactToolbar className="ddb-output-toolbar" aria-label="执行结果工具栏"><strong>执行结果</strong><span>{model.status}</span>
      <ToolbarButtonComponent icon={clearIcon} label="清空显示" enabled={model.outputs.length > 0}
        onClick={() => { model.outputs = []; model.changed.emit(); }} tooltip="只清空当前显示，刷新页面可恢复会话历史"/></ReactToolbar>
    {model.notice && <div className="ddb-dos-notice" role="status">{model.notice}</div>}
    {!model.outputs.length && <div className="ddb-output-empty">运行文件，或选中代码后按 Ctrl + Enter。<br/><small>每个 DOS 文件使用独立会话。</small></div>}
    <Accordion expandMode="multi">{model.outputs.map(output => <AccordionItem key={output.id} expanded className="ddb-output-entry"
      onChange={() => { following.current = false; }}>
      <span slot="heading" className="ddb-output-heading"><span>{output.label}</span><small>{output.status === 'running' ? '运行中' : output.error ? '执行失败' : output.elapsed !== undefined ? `${Math.round(output.elapsed)} ms` : '预览'}</small></span>
      <NativeOutput entry={output} rendermime={rendermime}/>
    </AccordionItem>)}</Accordion>
  </section>;
}

export function createDosToolbar({ model, runFile, runSelection, batch, showWorkspace }: { model: DosModel; runFile: () => unknown; runSelection: () => unknown; batch: () => unknown; showWorkspace: () => void }): SessionToolbar {
  return new SessionToolbar({ label: 'DolphinDB 文件工具栏', changed: model.changed,
    state: () => ({ profiles: model.manager.connections.state.connections, profile: model.profile, defaultProfile: model.manager.defaultProfile,
      selection: model.selection, locked: model.locked, busy: model.executing, disabled: model.locked || model.busy || Boolean(model.session),
      canClose: Boolean(model.session) && !model.executing && !model.loading, status: model.status, label: 'DOS 文件连接',
      closeDescription: `关闭 ${model.path} 的 DolphinDB 会话？会话变量将被释放，文件内容会保留。`,
      select: id => model.select(id), close: () => model.closeSession(), showWorkspace }),
    actions: [
      { name: 'run', label: '运行文件', icon: runIcon, tooltip: '运行整个 DOS 文件（Ctrl + Shift + Enter）', run: runFile, enabled: () => !model.executing && !model.loading },
      { name: 'selection', label: '运行选中/当前行', tooltip: '运行选中代码；没有选区时运行当前行（Ctrl + Enter）', run: runSelection, enabled: () => !model.executing && !model.loading },
      { name: 'batch', label: '批量运行', tooltip: '依次运行打开的或文件浏览器选中的 DOS 文件', run: batch },
      { name: 'interrupt', label: '中断', icon: stopIcon, tooltip: '中断当前会话的执行', run: () => model.interrupt(), enabled: () => model.executing },
    ] });
}

function WorkspaceHeader({ model, path, scope }: WorkspaceBinding): React.ReactElement {
  return <div className="ddb-document-workspace">
    <header><strong title={path()}>{path().split('/').pop()}</strong><span>{model.status}</span></header>
    <div className="ddb-session-meta"><span>{model.profile?.name ?? '未选择连接'}</span>
      <small>{model.locked ? `连接已固定 · ${scope === 'kernel' ? '当前 Python 内核的 DDB 会话' : '此文件独立会话'}` : '首次运行前可切换连接'}</small>
    </div>
  </div>;
}

type Schedule = (key: string, action: () => void | Promise<void>) => void;

function DatabaseItem({ database, model, schedule }: { database: WorkspaceModel['databases'][number]; model: WorkspaceModel; schedule: Schedule }): React.ReactElement {
  const item = React.useRef<TreeItemElement>(null);
  const toggle = () => { if (item.current) { item.current.expanded = !item.current.expanded; } };
  return <TreeItem ref={item} className="jp-TreeItem ddb-database" aria-label={database.path} title={database.path}
    onKeyDown={event => { if (event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); toggle(); } }}>
    <span className="ddb-database-name" onClick={toggle}>{database.catalog ?? database.path}</span><span slot="end">{database.tables.length}</span>
    {database.tables.map(table => {
      const preview = () => { if (!model.executing) { schedule('table-preview', () => model.inspectTable(database.path, table)); } };
      return <TreeItem key={table} className="jp-TreeItem ddb-table-item" disabled={model.executing} aria-label={table}
        title={`预览 ${database.path}/${table} 的前 100 行`} onClick={preview}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); preview(); } }}>
        <spreadsheetIcon.react slot="start" width="16" height="16"/><span>{table}</span>
      </TreeItem>;
    })}
    {!database.tables.length && <TreeItem disabled>暂无可见表</TreeItem>}
  </TreeItem>;
}

function DatabaseContent({ model, schedule }: { model: WorkspaceModel; schedule: Schedule }): React.ReactElement {
  return <div className="ddb-data-section">
      {model.panelLoading && <p className="ddb-muted">正在读取数据库…</p>}
      {model.databaseError && <p className="ddb-panel-error">{model.databaseError}</p>}
      {!model.panelLoading && !model.databaseError && !model.databases.length && <p className="ddb-muted">{model.profile ? '暂无可见的 DFS 数据库。' : '选择连接后显示数据库。'}</p>}
      <TreeView className="jp-TreeView" aria-label="DolphinDB 数据库">{model.databases.map(database => <DatabaseItem key={database.path} database={database} model={model} schedule={schedule}/>)}</TreeView>
  </div>;
}

function VariablesContent({ binding: { model, captureInsertion }, schedule }: { binding: WorkspaceBinding; schedule: Schedule }): React.ReactElement {
  const [filter, setFilter] = React.useState('');
  const updateFilter = React.useCallback((_filter: unknown, query?: string) => setFilter(query ?? ''), []);
  return <div className="ddb-data-section">
      {!model.locked ? <p className="ddb-muted">首次运行 DDB 后，显示当前会话的变量。</p> : <>
        {model.variablesError && <p className="ddb-panel-error">{model.variablesError}</p>}
        {(model.variables.length > 5 || filter) && <FilterBox placeholder="搜索变量" initialQuery={filter} useFuzzyFilter={false} updateFilter={updateFilter}/>}
        {!model.variables.length && !model.variablesError && <p className="ddb-muted">此会话暂无变量。</p>}
        <TreeView className="jp-TreeView" aria-label="DolphinDB 会话变量">{model.variables.filter(v => v.name.toLowerCase().includes(filter.toLowerCase())).map(variable => {
          const insert = () => { const action = captureInsertion(variable.name); if (action) { schedule('insert-variable', action); } };
          return <TreeItem key={variable.name} className="jp-TreeItem ddb-variable"
          aria-label={`插入变量 ${variable.name}`} title={`点击插入变量名 · ${variable.type} · ${variable.form} · ${variable.bytes} bytes`}
          onMouseDown={event => { if (event.button === 0) { event.preventDefault(); } }}
          onClick={insert} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); insert(); } }}>
          <code>{variable.name}</code><small slot="end">{variable.type}{variable.shared ? ' · 共享' : ''}</small>
          <span className="ddb-variable-value">{variable.value ?? `${variable.rows} × ${variable.columns} · ${variable.form}`}</span>
        </TreeItem>; })}</TreeView>
      </>}
  </div>;
}

class WorkspaceView extends ReactWidget {
  constructor(private content: () => React.ReactElement) { super(); }
  render(): React.ReactElement { return this.content(); }
}

/** Use the same native accordion layout as Jupyter's Debugger sidebar. */
export class WorkspacePanel extends SidePanel {
  binding: WorkspaceBinding | null = null;
  private session = '';
  private actionError = '';
  private actions = this.createActions();
  private heading = new WorkspaceView(() => <>
    {this.binding ? <WorkspaceHeader {...this.binding}/> : <div className="ddb-output-empty">打开 DOS 文件或 Notebook，查看对应会话的数据库与变量。</div>}
    {this.actionError && <p role="alert" className="ddb-panel-error">{this.actionError}</p>}
  </>);
  private databases = new PanelWithToolbar();
  private variables = new PanelWithToolbar();
  private databaseView = new WorkspaceView(() => this.binding ? <DatabaseContent key={`${this.binding.path()}:${this.binding.model.profile?.name}`}
    model={this.binding.model} schedule={this.schedule}/> : <></>);
  private variablesView = new WorkspaceView(() => this.binding ? <VariablesContent key={this.binding.path()} binding={this.binding} schedule={this.schedule}/> : <></>);
  private count = new WorkspaceView(() => <span className="ddb-variable-count">{this.binding?.model.variables.length ?? 0}</span>);
  private refreshButton = new ToolbarButton({ icon: refreshIcon, tooltip: '刷新数据库和变量', onClick: () => {
    const model = this.binding?.model;
    if (model) { this.schedule('refresh', () => model.refreshPanels()); }
  } });

  constructor() {
    super();
    this.header.addWidget(this.heading);
    this.databases.title.label = '数据库';
    this.variables.title.label = '变量';
    this.databases.toolbar.addItem('refresh', this.refreshButton);
    this.variables.toolbar.addItem('count', this.count);
    this.databases.addWidget(this.databaseView);
    this.variables.addWidget(this.variablesView);
    for (const section of [this.databases, this.variables]) { section.addClass('ddb-workspace-section'); this.addWidget(section); }
    (this.content as AccordionPanel).setRelativeSizes([1, 1]);
    this.refresh();
  }

  setBinding(binding: WorkspaceBinding | null): void {
    if (this.binding !== binding) {
      this.binding?.model.changed.disconnect(this.refresh, this);
      this.binding = binding;
      this.binding?.model.changed.connect(this.refresh, this);
      this.resetActions();
    }
    this.refresh();
  }

  private createActions(): DebouncedActions {
    return new DebouncedActions(error => { this.actionError = error instanceof Error ? error.message : '操作失败，请重试。'; this.heading.update(); });
  }

  private resetActions(): void {
    this.actions.dispose();
    this.actions = this.createActions();
    this.actionError = '';
    this.session = this.binding?.identity() ?? '';
  }

  private schedule: Schedule = (key, action) => {
    const binding = this.binding;
    if (!binding) { return; }
    const session = binding.identity();
    this.actionError = '';
    this.heading.update();
    this.actions.schedule(key, () => {
      if (this.binding === binding && binding.isCurrent() && binding.identity() === session) { return action(); }
    });
  };

  private refresh(): void {
    if ((this.binding?.identity() ?? '') !== this.session) { this.resetActions(); }
    const model = this.binding?.model;
    this.refreshButton.enabled = Boolean(model && !model.panelLoading && !model.executing);
    for (const view of [this.heading, this.databaseView, this.variablesView, this.count]) { view.update(); }
  }

  dispose(): void {
    if (this.isDisposed) { return; }
    this.binding?.model.changed.disconnect(this.refresh, this);
    this.actions.dispose();
    super.dispose();
    this.databases.toolbar.dispose();
    this.variables.toolbar.dispose();
  }
}
