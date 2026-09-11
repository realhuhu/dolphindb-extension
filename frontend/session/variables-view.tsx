import * as React from 'react';
import { TreeItem, TreeView, type TreeItemElement } from '@jupyter/react-components';
import { FilterBox } from '@jupyterlab/ui-components';
import type { VariableEntry } from '../dos/runtime';
import { ResultTable } from '../dos/output';
import type { WorkspaceBinding } from './types';
import { caretRightIcon } from '../icons';
import { useWorkspaceHover, WorkspaceTooltip } from './hover';
import { formatBytes, groupVariables, memoryBytes, variableDescription, VARIABLE_PREVIEW_LIMIT, type VariableGroup } from './variables';

type Schedule = (key: string, action: () => void | Promise<void>) => void;

export function VariablesContent({ binding, schedule, viewport }: { binding: WorkspaceBinding; schedule: Schedule; viewport: HTMLElement }): React.ReactElement {
  const { model } = binding;
  const [filter, setFilter] = React.useState('');
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());
  const [searchCollapsed, setSearchCollapsed] = React.useState<ReadonlySet<string>>(new Set());
  React.useEffect(() => setSearchCollapsed(new Set()), [filter]);
  const updateFilter = React.useCallback((_filter: unknown, query?: string) => setFilter(query ?? ''), []);
  const preview = useWorkspaceHover<VariableEntry>(binding, {
    snapshot: () => model.variables, key: variable => `${variable.shared}:${variable.name}`,
    read: variable => model.previewVariable(variable.name),
    blocked: variable => memoryBytes(variable.bytes) > VARIABLE_PREVIEW_LIMIT ? '超过 10 KiB，仅显示类型、大小和数量。' : null,
    error: '无法读取此变量，变量可能已变化。请刷新后重试。',
  });
  const locations = React.useMemo(() => groupVariables(model.variables, filter), [model.variables, filter]);
  const group = (entry: VariableGroup, key: string, children: React.ReactNode) => {
    const searching = Boolean(filter.trim());
    const expanded = !(searching ? searchCollapsed : collapsed).has(key);
    const setExpanded = (value: boolean) => {
      preview.dismiss();
      (searching ? setSearchCollapsed : setCollapsed)(previous => {
        const next = new Set(previous); if (value) { next.delete(key); } else { next.add(key); } return next;
      });
    };
    return <TreeItem key={key} expanded={expanded} className="jp-TreeItem ddb-variable-group" aria-label={entry.label}
      onExpand={event => {
        const value = (event.currentTarget as TreeItemElement).expanded;
        if (event.target === event.currentTarget && value !== expanded) { setExpanded(value); }
      }}
      onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); event.stopPropagation(); setExpanded(!expanded);
      } }}>
      <caretRightIcon.react slot="expand-collapse-glyph" className="ddb-tree-chevron" width="12px" height="12px"/>
      <span className="ddb-variable-group-name" onClick={event => { event.stopPropagation(); setExpanded(!expanded); }}>{entry.label}</span>
      <span slot="end" className="ddb-variable-stat" title={`${entry.variables.length} 个变量 · ${entry.bytes} bytes`}>{entry.variables.length} · {formatBytes(entry.bytes)}</span>
      {children}
    </TreeItem>;
  };
  return <div className="ddb-data-section ddb-variables-section">
    {!model.locked ? <p className="ddb-muted">首次运行 DDB 后，显示当前会话的变量。</p> : <>
      {model.variablesError && <p className="ddb-panel-error">{model.variablesError}</p>}
      {(model.variables.length > 5 || filter) && <FilterBox placeholder="搜索变量" initialQuery={filter} useFuzzyFilter={false} updateFilter={updateFilter}/>}
      {!model.variables.length && !model.variablesError && <p className="ddb-muted">此会话暂无变量。</p>}
      {model.variables.length > 0 && !locations.length && <p className="ddb-muted">没有匹配的变量。</p>}
      <TreeView className="jp-TreeView" aria-label="DolphinDB 会话变量">
        {locations.map(location => group(location, location.key, location.groups.map(form => group(form, `${location.key}:${form.key}`,
          form.variables.map(variable => {
            const insert = () => { preview.dismiss(); const action = binding.captureInsertion(variable.name); if (action) { schedule('insert-variable', action); } };
            return <TreeItem key={variable.name} className="jp-TreeItem ddb-variable" aria-label={`插入变量 ${variable.name}`}
              aria-describedby={preview.hover?.item === variable ? preview.id : undefined}
              onMouseEnter={event => preview.enter(variable, event.currentTarget)} onMouseLeave={preview.leave}
              onFocus={event => preview.enter(variable, event.currentTarget)} onBlur={preview.leave}
              onMouseDown={event => { if (event.button === 0) { event.preventDefault(); } }}
              onClick={event => { event.stopPropagation(); insert(); }}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); insert(); } }}>
              <span className="ddb-variable-label"><code>{variable.name}</code><span className="ddb-variable-value">{variableDescription(variable)}</span></span>
              <span slot="end" className="ddb-variable-stat">{formatBytes(variable.bytes)}</span>
            </TreeItem>;
          })
        ))))}
      </TreeView>
    </>}
    {preview.hover && <WorkspaceTooltip controller={preview} anchor={preview.hover.anchor} viewport={viewport}>
      <div className="ddb-hover-preview ddb-variable-preview" aria-busy={preview.hover.loading}>
        <header><code>{preview.hover.item.name}</code><span>{formatBytes(preview.hover.item.bytes)}</span></header>
        <div className="ddb-variable-preview-meta">{preview.hover.item.type} · {preview.hover.item.form} · {preview.hover.item.shared ? '共享变量' : '本地变量'}</div>
        <div className="ddb-variable-preview-meta">{variableDescription({ ...preview.hover.item, value: undefined })} · {memoryBytes(preview.hover.item.bytes).toLocaleString('zh-CN')} bytes</div>
        {preview.hover.value?.columns ? <ResultTable value={preview.hover.value} showSummary={false}/>
          : <pre>{preview.hover.value?.text ?? preview.hover.text}</pre>}
        {preview.hover.value?.rows && <div className="ddb-variable-preview-meta">
          {preview.hover.value.totalRows! > preview.hover.value.rows.length ? `显示前 ${preview.hover.value.rows.length} 行。` : ''}
          {preview.hover.value.totalColumns! > preview.hover.value.columns!.length ? '部分列已省略。' : ''}
        </div>}
        <footer>点击变量名插入光标位置</footer>
      </div>
    </WorkspaceTooltip>}
  </div>;
}
