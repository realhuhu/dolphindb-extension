import * as React from 'react';
import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { MainAreaWidget, ReactWidget } from '@jupyterlab/apputils';
import { HTMLSelect, ToolbarButtonComponent } from '@jupyterlab/ui-components';
import { Toolbar as ReactToolbar } from '@jupyter/react-components';
import { IRenderMimeRegistry, type IRenderMime } from '@jupyterlab/rendermime';
import { Token } from '@lumino/coreutils';
import { IExtensionSettings, type SettingsModel } from '../settings';
import { ResultTable } from '../dos/output';
import { dataExplorerIcon, refreshIcon, caretRightIcon, backIcon, openIcon } from '../icons';
import { DATA_MIME, SHOW_MIME, FIRST_PAGE, dataTicket, type DataPage, type DataSource, type DataTicket, type BrowseRequest, type DataTarget } from './types';
import { defaultPage, readSnapshot } from './registry';
import { DataChart } from './chart';
import { bindDisplaySettings, useDecimals } from './preferences';
import { formatNumeric } from './format';

function PageInput({ page, pages, disabled, change }: { page: number; pages: number; disabled: boolean; change: (page: number) => void }): React.ReactElement {
  const [draft, setDraft] = React.useState(String(page));
  React.useEffect(() => setDraft(String(page)), [page]);
  const commit = () => {
    const value = Number(draft);
    if (Number.isInteger(value) && value >= 1 && value <= pages) { if (value !== page) { change(value); } }
    else { setDraft(String(page)); }
  };
  return <input className="jp-mod-styled" aria-label="数据页码" type="number" min="1" max={pages} value={draft}
    disabled={disabled} onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') { commit(); } if (event.key === 'Escape') { setDraft(String(page)); } }}/>;
}

function DataViewer({ source, initial, initialRequest, service, inline = false }: { source: DataSource; initial?: DataPage; initialRequest?: BrowseRequest; service: DataBrowser; inline?: boolean }): React.ReactElement {
  const firstRequest = React.useRef(initial ? initialRequest ?? FIRST_PAGE : defaultPage());
  const [request, setRequest] = React.useState<BrowseRequest>(firstRequest.current);
  const columnLimit = request.columnLimit ?? 50;
  const [page, setPage] = React.useState(initial);
  const [revision, refresh] = React.useState(0);
  const [loading, setLoading] = React.useState(false), [error, setError] = React.useState('');
  const [trail, setTrail] = React.useState<string[]>([]);
  const decimals = useDecimals();
  React.useEffect(() => {
    if (initial && !revision && request === firstRequest.current) { return; }
    let current = true;
    setLoading(true); setError('');
    void source.read({ ...request, revision }).then(value => { if (current) { setPage(value); } }, reason => {
      if (current) { setError(reason instanceof Error ? reason.message : '无法读取数据。'); }
    }).finally(() => { if (current) { setLoading(false); } });
    return () => { current = false; };
  }, [source, request, revision, initial]);
  const count = page?.count ?? 0, pages = Math.max(1, Math.ceil(count / request.limit));
  const navigate = (path: number[], names: string[]) => { setTrail(names); setPage(undefined); setRequest({ ...request, path, offset: 0, columnOffset: 0 }); };
  return <section className={`ddb-browser${inline ? ' ddb-browser-inline' : ''}`} aria-label={source.title} aria-busy={loading}>
    <ReactToolbar className="jp-Toolbar ddb-browser-toolbar" aria-label="数据浏览工具栏">
      <ToolbarButtonComponent icon={refreshIcon} tooltip="刷新数据" enabled={!loading} onClick={() => { setRequest({ ...request, offset: 0, columnOffset: 0 }); refresh(n => n + 1); }}/>
      <span className="ddb-browser-summary">{page?.form} {page?.type && page.type !== page.form && page.type !== 'VOID' ? `<${page.type}>` : ''}{page?.shape ? ` [${page.shape.join(' × ')}]` : ''}</span>
      {inline && <ToolbarButtonComponent icon={openIcon} tooltip="在独立标签页查看" onClick={() => service.open(source)}/>}
    </ReactToolbar>
    {trail.length > 0 && <ReactToolbar className="jp-Toolbar ddb-browser-breadcrumbs" aria-label="对象路径">
      <ToolbarButtonComponent label="根对象" onClick={() => navigate([], [])}/>
      {trail.map((name, index) => <ToolbarButtonComponent key={index} label={`› ${name}`} onClick={() => navigate(request.path.slice(0, index + 1), trail.slice(0, index + 1))}/>)}
    </ReactToolbar>}
    {error && <p className="ddb-panel-error" role="alert">{error}</p>}
    <div className="ddb-browser-body">
      {!page && <p className="ddb-muted">{loading ? '正在读取数据…' : error ? '' : '暂无数据'}</p>}
      {page?.chart && <DataChart value={page.chart}/>}
      {page?.grid && <ResultTable value={page.grid} showSummary={false}/>}
      {page?.text !== undefined && <pre className="ddb-browser-scalar">{page.numeric ? formatNumeric(page.text, decimals) : page.text}</pre>}
      {page?.children && page.children.length > 0 && <div className="ddb-browser-children" aria-label={page.form === 'TABLE' ? '逐列查看' : '子对象'}>
        {page.form === 'TABLE' && <span className="ddb-muted">逐列查看：</span>}
        {page.children.map(child => <ToolbarButtonComponent key={child.index} icon={caretRightIcon} label={child.label}
          tooltip={child.description} enabled={!loading} onClick={() => navigate([...request.path, child.index], [...trail, child.label])}/>)}
      </div>}
    </div>
    {page && !page.chart && page.text === undefined && <ReactToolbar className="jp-Toolbar ddb-browser-pagination" aria-label="数据分页">
      <ToolbarButtonComponent label="首页" enabled={!loading && request.offset > 0} onClick={() => setRequest({ ...request, offset: 0 })}/>
      <ToolbarButtonComponent icon={backIcon} tooltip="上一页" enabled={!loading && request.offset > 0} onClick={() => setRequest({ ...request, offset: Math.max(0, request.offset - request.limit) })}/>
      <label>第 <PageInput page={Math.floor(request.offset / request.limit) + 1} pages={pages} disabled={loading}
        change={n => setRequest({ ...request, offset: (n - 1) * request.limit })}/> / {pages} 页</label>
      <ToolbarButtonComponent icon={caretRightIcon} tooltip="下一页" enabled={!loading && request.offset + request.limit < count} onClick={() => setRequest({ ...request, offset: request.offset + request.limit })}/>
      <ToolbarButtonComponent label="末页" enabled={!loading && request.offset + request.limit < count} onClick={() => setRequest({ ...request, offset: (pages - 1) * request.limit })}/>
      <HTMLSelect aria-label="每页行数" value={request.limit} disabled={loading} onChange={event => setRequest({ ...request, limit: Number(event.target.value), offset: 0 })}>
        {[...new Set([10, 20, 50, 100, 200, 500, 1000, request.limit])].sort((a, b) => a - b).map(n => <option key={n} value={n}>{n} / 页</option>)}
      </HTMLSelect>
      <span>{count.toLocaleString()} {page.form === 'TABLE' || page.form === 'MATRIX' ? '行' : '项'}</span>
      {(page.columnCount ?? 0) > columnLimit && <>
        <ToolbarButtonComponent label={`前 ${columnLimit} 列`} enabled={!loading && request.columnOffset > 0} onClick={() => setRequest({ ...request, columnOffset: Math.max(0, request.columnOffset - columnLimit) })}/>
        <span>列 {request.columnOffset + 1}–{Math.min(page.columnCount!, request.columnOffset + columnLimit)} / {page.columnCount}</span>
        <ToolbarButtonComponent label={`后 ${columnLimit} 列`} enabled={!loading && request.columnOffset + columnLimit < page.columnCount!} onClick={() => setRequest({ ...request, columnOffset: request.columnOffset + columnLimit })}/>
      </>}
    </ReactToolbar>}
  </section>;
}

type Provider = (target: DataTarget, request: BrowseRequest) => Promise<DataPage>;
export class DataBrowser {
  private providers = new Map<string, Set<Provider>>();
  constructor(private app: JupyterFrontEnd, settings: SettingsModel) { bindDisplaySettings(settings); }
  register(owner: string, provider: Provider): () => void {
    const providers = this.providers.get(owner) ?? new Set<Provider>();
    providers.add(provider); this.providers.set(owner, providers);
    return () => { providers.delete(provider); if (!providers.size) { this.providers.delete(owner); } };
  }
  ticketSource(ticket: DataTicket): DataSource {
    return { title: ticket.title, read: request => {
      if (ticket.owner === 'browser' && ticket.target.kind === 'result') { return readSnapshot(ticket.target.id, request); }
      const provider = [...(this.providers.get(ticket.owner) ?? [])].at(-1);
      if (!provider) { return Promise.reject(new Error('原 Python 内核尚未连接，或结果来自已结束的内核。请打开原 Notebook 后重试。')); }
      return provider(ticket.target, request);
    } };
  }
  open(source: DataSource): void {
    const content = ReactWidget.create(<DataViewer source={source} service={this}/>);
    content.addClass('ddb-browser-widget');
    const widget = new MainAreaWidget({ content });
    widget.id = `dolphindb-data-${crypto.randomUUID()}`;
    widget.title.label = source.title; widget.title.caption = source.title; widget.title.icon = dataExplorerIcon;
    this.app.shell.add(widget, 'main'); this.app.shell.activateById(widget.id);
  }
  renderer(mimeType = DATA_MIME): IRenderMime.IRenderer {
    const service = this;
    return new class extends ReactWidget implements IRenderMime.IRenderer {
      private ticket: DataTicket | null = null;
      private source: DataSource | null = null;
      async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
        this.ticket = dataTicket(model.data[mimeType]);
        this.source = this.ticket ? service.ticketSource(this.ticket) : null;
        this.update(); await this.renderPromise;
      }
      render(): React.ReactElement { return this.ticket && this.source ? <DataViewer key={`${this.ticket.owner}:${this.ticket.target.kind === 'result' ? this.ticket.target.id : ''}`} source={this.source} initial={this.ticket.initial} initialRequest={this.ticket.initialRequest} service={service} inline/>
        : <p role="alert">无法显示 DolphinDB 数据。</p>; }
    }();
  }
}

export const IDataBrowser = new Token<DataBrowser>('dolphindb-extension:IDataBrowser');
export default {
  id: 'dolphindb-extension:data-browser', autoStart: true, provides: IDataBrowser,
  requires: [IExtensionSettings, IRenderMimeRegistry],
  activate: (app: JupyterFrontEnd, settings: SettingsModel, rendermime: IRenderMimeRegistry) => {
    const browser = new DataBrowser(app, settings);
    rendermime.addFactory({ safe: true, mimeTypes: [SHOW_MIME], createRenderer: () => browser.renderer(SHOW_MIME) }, -10);
    return browser;
  },
} satisfies JupyterFrontEndPlugin<DataBrowser>;
