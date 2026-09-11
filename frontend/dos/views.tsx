import * as React from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { Accordion, AccordionItem, Toolbar as ReactToolbar, TreeItem, TreeView, type AccordionItemElement, type TreeItemElement } from '@jupyter/react-components';
import { SidePanel, PanelWithToolbar, ToolbarButton, ToolbarButtonComponent } from '@jupyterlab/ui-components';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { AccordionPanel } from '@lumino/widgets';
import type { DosModel } from './model';
import { NativeOutput, ResultTable } from './output';
import { SessionToolbar } from '../session/toolbar';
import type { WorkspaceBinding, WorkspaceModel } from '../session/types';
import { DebouncedActions, loadTableExpression } from '../session/interactions';
import { VariablesContent } from '../session/variables-view';
import { formatBytes, totalBytes } from '../session/variables';
import { useWorkspaceHover, WorkspaceTooltip, type WorkspaceHover } from '../session/hover';
import { schemaDisplayValue } from '../session/schema';
import { ActionsButton, openActions, type MenuAction } from '../session/menu';
import { TABLE_ACTIONS, tableDefinition, tableStatement } from '../session/table-actions';
import { usePreferences } from '../data/preferences';
import { runIcon, stopIcon, refreshIcon, clearIcon, tableIcon, previewIcon, caretDownIcon, caretRightIcon, collapseAllIcon, expandAllIcon } from '../icons';

function useModel(model: Pick<WorkspaceModel, 'changed'>): void {
  const [, update] = React.useReducer(n => n + 1, 0);
  React.useEffect(() => { model.changed.connect(update); return () => { model.changed.disconnect(update); }; }, [model]);
}

export function OutputPanel({ model, rendermime }: { model: DosModel; rendermime: IRenderMimeRegistry }): React.ReactElement {
  useModel(model);
  const { output: preferences } = usePreferences();
  const region = React.useRef<HTMLElement>(null);
  const following = React.useRef(false);
  const latest = model.outputs.at(-1);
  const folding = model.folding;
  folding.setDefault(preferences.defaultExpanded);
  folding.retain(model.outputs.map(output => output.id));
  React.useLayoutEffect(() => {
    const parent = region.current?.parentElement;
    following.current = preferences.autoScroll && !folding.collapsed && Boolean(latest && folding.expanded(latest.id));
    if (parent && following.current) { parent.scrollTop = parent.scrollHeight; }
  }, [model.outputs.length, latest?.id, latest?.prints.length, latest?.value, latest?.error, latest?.status, folding.collapsed, preferences.autoScroll]);
  React.useLayoutEffect(() => {
    const parent = region.current?.parentElement;
    if (!parent) { return; }
    let visible = parent.clientWidth > 0 && parent.clientHeight > 0;
    // Inactive document tabs have no layout yet; follow restored output once revealed.
    const observer = new ResizeObserver(() => {
      const nextVisible = parent.clientWidth > 0 && parent.clientHeight > 0;
      if (nextVisible && !visible && !model.folding.collapsed) { following.current = preferences.autoScroll && Boolean(model.outputs.at(-1) && model.folding.expanded(model.outputs.at(-1)!.id)); }
      visible = nextVisible;
      if (following.current && visible && !model.folding.collapsed && model.outputs.length) { parent.scrollTop = parent.scrollHeight; }
    });
    observer.observe(parent);
    // MIME renderers finish asynchronously, after the enclosing React render.
    observer.observe(region.current!);
    return () => observer.disconnect();
  }, [model, preferences.autoScroll]);
  const setAll = (expanded: boolean) => { following.current = false; folding.setAll(expanded); model.changed.emit(); };
  return <section ref={region} className="ddb-output" aria-label={`执行结果 ${model.path}`}>
    <ReactToolbar className="jp-Toolbar ddb-output-toolbar" aria-label="执行结果工具栏">
      <ToolbarButtonComponent icon={folding.collapsed ? caretRightIcon : caretDownIcon} label="执行结果"
        tooltip={folding.collapsed ? '展开执行结果面板' : '收起执行结果面板'} aria-expanded={!folding.collapsed}
        onClick={() => { following.current = false; folding.collapsed = !folding.collapsed; model.changed.emit(); }}/>
      <span className="ddb-output-status">{model.status}</span>
      <ToolbarButtonComponent icon={collapseAllIcon} tooltip="全部折叠" enabled={model.outputs.length > 0} onClick={() => setAll(false)}/>
      <ToolbarButtonComponent icon={expandAllIcon} tooltip="全部展开" enabled={model.outputs.length > 0} onClick={() => setAll(true)}/>
      <ToolbarButtonComponent icon={clearIcon} label="清空显示" enabled={model.outputs.length > 0}
        onClick={() => { model.outputs = []; model.changed.emit(); }} tooltip="只清空当前显示，刷新页面可恢复会话历史"/></ReactToolbar>
    <div hidden={folding.collapsed}>
    {model.notice && <div className="ddb-dos-notice" role="status">{model.notice}</div>}
    {!model.outputs.length && <div className="ddb-output-empty">运行文件，或选中代码后按 Ctrl + Enter。<br/><small>每个 DOS 文件使用独立会话。</small></div>}
    <Accordion expandMode="multi">{model.outputs.map(output => <AccordionItem key={output.id} expanded={folding.expanded(output.id)} className="ddb-output-entry"
      onChange={event => {
        if (event.target !== event.currentTarget) { return; }
        const expanded = (event.target as AccordionItemElement).expanded;
        if (folding.expanded(output.id) === expanded) { return; }
        following.current = false; folding.setExpanded(output.id, expanded); model.changed.emit();
      }}>
      <caretDownIcon.react slot="expanded-icon" width="16px" height="16px"/>
      <caretRightIcon.react slot="collapsed-icon" width="16px" height="16px"/>
      <span slot="heading" className="ddb-output-heading"><span>{output.label}</span><small>{output.status === 'running' ? '运行中' : output.error ? '执行失败' : output.elapsed !== undefined ? `${Math.round(output.elapsed)} ms` : '预览'}</small></span>
      <NativeOutput entry={output} rendermime={rendermime}/>
    </AccordionItem>)}</Accordion>
    </div>
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
type TableReference = { database: string; table: string };

function DatabaseItem({ database, binding, schedule, schema }: {
  database: WorkspaceModel['databases'][number]; binding: WorkspaceBinding; schedule: Schedule; schema: WorkspaceHover<TableReference>;
}): React.ReactElement {
  const { model, captureInsertion, openData } = binding;
  const { preview: previewSettings } = usePreferences();
  const [expanded, setExpanded] = React.useState(false);
  const databaseActions = () => [{ label: '查看数据库完整结构', run: () => openData?.({ kind: 'database-schema', database: database.path }, `${database.catalog ?? database.path} · 结构`) }];
  const toggle = () => { schema.dismiss(); setExpanded(value => !value); };
  return <TreeItem expanded={expanded} className="jp-TreeItem ddb-database" aria-label={database.path} title={database.path}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openActions(databaseActions(), event.clientX, event.clientY); }}
    onExpand={event => { if (event.target === event.currentTarget) { setExpanded((event.target as TreeItemElement).expanded); } }}
    onKeyDown={event => { if (event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); toggle(); } }}>
    <caretRightIcon.react slot="expand-collapse-glyph" className="ddb-tree-chevron" width="12px" height="12px"/>
    <span className="ddb-database-name" onClick={toggle}>{database.catalog ?? database.path}</span><span slot="end" className="ddb-tree-actions"><span>{database.tables.length}</span><ActionsButton title="数据库操作" actions={databaseActions} enabled={!model.executing}/></span>
    {database.tables.map(table => {
      const reference = { database: database.path, table };
      const preview = () => { schema.dismiss(); if (!model.executing) { schedule('table-preview', () => model.inspectTable(database.path, table)); } };
      const insert = () => { schema.dismiss(); const action = captureInsertion(loadTableExpression(database.path, table)); if (action) { schedule('insert-table', action); } };
      const actions = (): MenuAction[] => [
        { label: '在数据浏览器查看完整表', run: () => openData?.({ kind: 'table', database: database.path, table }, table) },
        { label: '查看表完整结构', run: () => openData?.({ kind: 'schema', database: database.path, table }, `${table} · 结构`) },
        ...TABLE_ACTIONS.map(action => {
          let statement = '';
          const apply = captureInsertion(() => statement);
          return { label: `插入 ${action === 'load' ? 'loadTable' : action} 语句`, run: () => schedule('table-statement', async () => {
            if (!apply || !binding.isCurrent()) { return; }
            const definition = ['select', 'update', 'delete'].includes(action) ? await tableDefinition(model, database.path, table) : undefined;
            statement = tableStatement(action, database.path, table, definition, database.catalog); apply();
          }) };
        }),
      ];
      return <TreeItem key={table} className="jp-TreeItem ddb-table-item" aria-label={table} title=""
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); schema.dismiss(); openActions(actions(), event.clientX, event.clientY); }}
        aria-describedby={schema.hover?.item.database === database.path && schema.hover.item.table === table ? schema.id : undefined}
        onFocus={event => { if (event.target === event.currentTarget) { schema.enter(reference, event.currentTarget); } }} onBlur={schema.leave}
        onMouseDown={event => { if (event.button === 0) { event.preventDefault(); } }} onClick={insert}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); insert(); } }}>
        <tableIcon.react slot="start" elementSize="normal"/><span className="ddb-table-name"
          onMouseEnter={event => schema.enter(reference, event.currentTarget)} onMouseLeave={schema.leave}>{table}</span>
        <span slot="end" className="ddb-table-preview-action" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
          <ActionsButton title={`${table} · 更多操作`} actions={actions} enabled={!model.executing}/>
          <ToolbarButtonComponent icon={previewIcon} tooltip={`预览 ${table} · 前 ${previewSettings.tableRows} 行`} enabled={!model.executing} onClick={preview}/>
        </span>
      </TreeItem>;
    })}
    {!database.tables.length && <TreeItem disabled>暂无可见表</TreeItem>}
  </TreeItem>;
}

function DatabaseContent({ binding, schedule, viewport }: { binding: WorkspaceBinding; schedule: Schedule; viewport: HTMLElement }): React.ReactElement {
  const { model } = binding;
  const preferences = usePreferences();
  const schema = useWorkspaceHover<TableReference>(binding, {
    enabled: preferences.preview.tableHover,
    snapshot: () => model.databases, key: ({ database, table }) => JSON.stringify([database, table]),
    read: async ({ database, table }) => schemaDisplayValue(await model.previewTableSchema(database, table)),
    error: '无法读取表结构，表可能已变化或当前账号没有权限。请刷新后重试。',
  });
  return <div className="ddb-data-section">
      {model.panelLoading && <p className="ddb-muted">正在读取数据库…</p>}
      {model.databaseError && <p className="ddb-panel-error">{model.databaseError}</p>}
      {!model.panelLoading && !model.databaseError && !model.databases.length && <p className="ddb-muted">{model.profile ? '暂无可见的 DFS 数据库。' : '选择连接后显示数据库。'}</p>}
      <TreeView className="jp-TreeView" aria-label="DolphinDB 数据库">{model.databases.map(database => <DatabaseItem key={database.path} database={database} binding={binding} schedule={schedule} schema={schema}/>)}</TreeView>
      {schema.hover && <WorkspaceTooltip controller={schema} anchor={schema.hover.anchor} viewport={viewport}>
        <div className="ddb-hover-preview ddb-schema-preview" aria-busy={schema.hover.loading}>
          <header><code>{schema.hover.item.table}</code><span>表结构</span></header>
          <div className="ddb-variable-preview-meta">{schema.hover.item.database}</div>
          {schema.hover.value ? <><ResultTable value={schema.hover.value} showSummary={false}/>
            <div className="ddb-variable-preview-meta">{schema.hover.value.totalRows} 个字段
              {schema.hover.value.totalRows! > schema.hover.value.rows!.length ? ` · 显示前 ${schema.hover.value.rows!.length} 个` : ''}</div></>
            : <pre>{schema.hover.text}</pre>}
          <footer>点击表名插入 loadTable(...)；眼睛按钮预览数据。</footer>
        </div>
      </WorkspaceTooltip>}
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
    binding={this.binding} schedule={this.schedule} viewport={this.viewport}/> : <></>);
  private variablesView = new WorkspaceView(() => this.binding ? <VariablesContent key={this.binding.path()} binding={this.binding} schedule={this.schedule} viewport={this.viewport}/> : <></>);
  private count = new WorkspaceView(() => {
    const variables = this.binding?.model.variables ?? [], bytes = totalBytes(variables);
    return <span className="ddb-variable-count" title={`${variables.length} 个变量 · ${bytes} bytes`}>{variables.length} · {formatBytes(bytes)}</span>;
  });
  private refreshButton = new ToolbarButton({ icon: refreshIcon, tooltip: '刷新数据库和变量', onClick: () => {
    const model = this.binding?.model;
    if (model) { this.schedule('refresh', () => model.refreshPanels()); }
  } });

  constructor(private viewport: HTMLElement) {
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
