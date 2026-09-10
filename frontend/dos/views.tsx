import * as React from 'react';
import { Dialog, ReactWidget, showDialog } from '@jupyterlab/apputils';
import { runIcon, stopIcon, refreshIcon } from '@jupyterlab/ui-components';
import type { DosModel } from './model';
import type { DisplayValue } from './runtime';

function useModel(model: DosModel): void {
  const [, update] = React.useReducer(n => n + 1, 0);
  React.useEffect(() => { model.changed.connect(update); return () => { model.changed.disconnect(update); }; }, [model]);
}

export function Result({ value }: { value: DisplayValue }): React.ReactElement {
  return value.columns ? <div className="ddb-result-grid"><table><thead><tr>{value.columns.map((column, i) => <th key={i}>{column}</th>)}</tr></thead>
    <tbody>{value.rows!.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} title={cell}>{cell}</td>)}</tr>)}</tbody></table>
    <small>{value.totalRows} 行 · {value.columns.length} 列{value.totalRows! > value.rows!.length ? ` · 显示前 ${value.rows!.length} 行` : ''}</small></div>
    : <pre className="ddb-result-text">{value.text || '执行完成'}</pre>;
}

export function OutputPanel({ model }: { model: DosModel }): React.ReactElement {
  useModel(model);
  const region = React.useRef<HTMLElement>(null);
  React.useLayoutEffect(() => {
    const parent = region.current?.parentElement;
    const last = region.current?.lastElementChild as HTMLElement | null;
    if (parent && last && model.outputs.length) { parent.scrollTop = Math.max(0, last.offsetTop - 34); }
  }, [model.outputs.at(-1)?.id]);
  return <section ref={region} className="ddb-output" aria-label={`执行结果 ${model.path}`}>
    <header><strong>执行结果</strong><span>{model.status}</span><button onClick={() => { model.outputs = []; model.changed.emit(); }} title="只清空当前显示，刷新页面可恢复会话历史">清空显示</button></header>
    {model.notice && <div className="ddb-dos-notice" role="status">{model.notice}</div>}
    {!model.outputs.length && <div className="ddb-output-empty">运行文件，或选中代码后按 Ctrl + Enter。<br/><small>每个 DOS 文件使用独立会话。</small></div>}
    {model.outputs.map(output => <details key={output.id} open className={`ddb-output-entry ${output.error ? 'ddb-output-error' : ''}`}>
      <summary>{output.label}<span>{output.status === 'running' ? '运行中' : output.error ? '执行失败' : output.elapsed !== undefined ? `${Math.round(output.elapsed)} ms` : '预览'}</span></summary>
      {output.prints.length > 0 && <pre className="ddb-print">{output.prints.join('\n')}</pre>}
      {output.error && <pre role="alert">{output.error}</pre>}
      {output.value && <Result value={output.value}/>}
    </details>)}
  </section>;
}

export function DosToolbar({ model, runFile, runSelection, batch }: { model: DosModel; runFile: () => void; runSelection: () => void; batch: () => void }): React.ReactElement {
  useModel(model);
  return <div className="ddb-dos-toolbar" role="toolbar" aria-label="DolphinDB 文件工具栏">
    <button onClick={runFile} disabled={model.executing || model.loading} title="运行整个 DOS 文件（Ctrl + Shift + Enter）"><runIcon.react width="16" height="16"/>运行文件</button>
    <button onClick={runSelection} disabled={model.executing || model.loading} title="运行选中代码；没有选区时运行当前行（Ctrl + Enter）">运行选中/当前行</button>
    <button onClick={batch} title="依次运行打开的或文件浏览器选中的 DOS 文件">批量运行</button>
    <button onClick={() => void model.interrupt()} disabled={!model.executing} title="中断当前会话的执行"><stopIcon.react width="14" height="14"/>中断</button>
    <label className="ddb-connection-picker"><span className={`ddb-session-dot ${model.executing ? 'busy' : model.locked ? 'ready' : ''}`}/>
      <select aria-label="DOS 文件连接" disabled={model.locked || model.busy || Boolean(model.session)} value={model.profile?.id ?? ''}
        title={model.locked ? '连接已固定。关闭会话后才能重新选择。' : '首次运行前可切换连接。'} onChange={event => { void model.select(event.target.value); }}>
        {!model.profile && <option value="">选择连接</option>}
        {model.session ? <option value={model.session.profile.id}>{model.session.profile.name} · 已固定</option>
          : model.manager.connections.state.connections.map(profile => <option key={profile.id} value={profile.id}>{profile.name}{profile.id === model.manager.connections.state.activeId ? ' · 默认' : ''}</option>)}
      </select>
    </label>
  </div>;
}

function WorkspaceContent({ model }: { model: DosModel }): React.ReactElement {
  useModel(model);
  const [filter, setFilter] = React.useState('');
  return <div className="ddb-document-workspace">
    <header><strong title={model.path}>{model.path.split('/').pop()}</strong><span>{model.status}</span></header>
    <div className="ddb-session-meta"><span>{model.profile?.name ?? '未选择连接'}</span>
      <small>{model.locked ? '连接已固定 · 此文件独立会话' : '首次运行前可切换连接'}</small>
      {model.session && <button onClick={async () => {
        const result = await showDialog({ title: '关闭 DOS 会话', body: `关闭 ${model.path} 的会话？该会话的变量将被释放，文件内容会保留。`, buttons: [Dialog.cancelButton({ label: '取消' }), Dialog.warnButton({ label: '关闭会话' })] });
        if (result.button.accept) { await model.manager.shutdown(model.session!.id); }
      }}>关闭会话</button>}
    </div>
    <section aria-label="Database 数据库面板" className="ddb-data-section">
      <h3>DATABASE<button title="刷新数据库和变量" aria-label="刷新数据库和变量" disabled={model.loading || model.executing} onClick={() => void model.refreshPanels()}><refreshIcon.react width="14" height="14"/></button></h3>
      {model.loading && <p className="ddb-muted">正在读取数据库…</p>}
      {model.databaseError && <p className="ddb-panel-error">{model.databaseError}</p>}
      {!model.loading && !model.databaseError && !model.databases.length && <p className="ddb-muted">{model.profile ? '暂无可见的 DFS 数据库。' : '选择连接后显示数据库。'}</p>}
      {model.databases.map(database => <details key={database.path} className="ddb-database"><summary title={database.path}>{database.catalog ?? database.path}<span>{database.tables.length}</span></summary>
        {database.tables.map(table => <button key={table} className="ddb-table-item" disabled={model.executing} title={`预览 ${database.path}/${table} 的前 100 行`} onClick={() => void model.inspectTable(database.path, table)}>▦ <span>{table}</span></button>)}
        {!database.tables.length && <p className="ddb-muted">暂无可见表</p>}
      </details>)}
    </section>
    <section aria-label="会话变量面板" className="ddb-data-section">
      <h3>变量<span>{model.variables.length}</span></h3>
      {!model.locked ? <p className="ddb-muted">首次运行后，显示此文件会话的变量。</p> : <>
        {model.variablesError && <p className="ddb-panel-error">{model.variablesError}</p>}
        {model.variables.length > 5 && <input className="ddb-variable-search" aria-label="搜索会话变量" placeholder="搜索变量" value={filter} onChange={e => setFilter(e.target.value)}/>}
        {!model.variables.length && !model.variablesError && <p className="ddb-muted">此会话暂无变量。</p>}
        {model.variables.filter(v => v.name.toLowerCase().includes(filter.toLowerCase())).map(variable => <div key={variable.name} className="ddb-variable" title={`${variable.type} · ${variable.form} · ${variable.bytes} bytes`}>
          <div><code>{variable.name}</code><small>{variable.type}{variable.shared ? ' · 共享' : ''}</small></div>
          <span>{variable.value ?? `${variable.rows} × ${variable.columns} · ${variable.form}`}</span>
        </div>)}
      </>}
    </section>
  </div>;
}

export class WorkspacePanel extends ReactWidget {
  model: DosModel | null = null;
  setModel(model: DosModel | null): void { this.model = model; this.update(); }
  render(): React.ReactElement { return this.model ? <WorkspaceContent key={this.model.path} model={this.model}/> : <div className="ddb-output-empty">打开 DOS 文件，查看该文件的数据库与会话变量。</div>; }
}
