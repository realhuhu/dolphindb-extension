import * as React from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { OutputAreaModel, SimplifiedOutputArea } from '@jupyterlab/outputarea';
import { Table } from '@jupyterlab/ui-components';
import type { IRenderMime, IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Widget } from '@lumino/widgets';
import type { OutputEntry } from './model';
import type { DisplayValue } from './runtime';
import { OutputAdapter, TABLE_MIME } from './output-model';

class DdbTableRenderer extends ReactWidget implements IRenderMime.IRenderer {
  private value: DisplayValue | null = null;
  async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    const data = model.data[TABLE_MIME] as DisplayValue | undefined;
    this.value = data && Array.isArray(data.columns) && data.columns.every(column => typeof column === 'string')
      && Array.isArray(data.rows) && data.rows.every(row => Array.isArray(row) && row.every(cell => typeof cell === 'string'))
      ? { columns: data.columns, rows: data.rows.slice(0, 100), totalRows: typeof data.totalRows === 'number' ? data.totalRows : data.rows.length,
        sortRanks: Array.isArray(data.sortRanks) ? data.sortRanks.map(ranks =>
          Array.isArray(ranks) && ranks.length === data.rows!.length && ranks.every(Number.isFinite) ? ranks.slice(0, 100) : null) : undefined } : null;
    this.update();
    await this.renderPromise;
  }
  render(): React.ReactElement {
    const value = this.value;
    if (!value) { return <p role="alert">无法显示 DolphinDB 表格。</p>; }
    return <div className="ddb-result-grid">
      <Table rows={value.rows!.map((cells, index) => ({ key: String(index), data: { cells, index } }))}
        columns={value.columns!.map((name, index) => ({ id: String(index), label: name,
          renderCell: (row: { cells: string[] }) => <span title={row.cells[index]}>{row.cells[index]}</span>,
          sort: (a: { cells: string[]; index: number }, b: { cells: string[]; index: number }) => {
            const ranks = value.sortRanks?.[index];
            return ranks ? ranks[a.index] - ranks[b.index] : (a.cells[index] ?? '').localeCompare(b.cells[index] ?? '');
          } }))}
        blankIndicator={() => '空表'}/>
      <small>{value.totalRows} 行 · {value.columns!.length} 列{value.totalRows! > value.rows!.length ? ` · 显示前 ${value.rows!.length} 行` : ''}</small>
    </div>;
  }
}

export function registerDdbRenderer(rendermime: IRenderMimeRegistry): void {
  if (!rendermime.getFactory(TABLE_MIME)) {
    rendermime.addFactory({ safe: true, mimeTypes: [TABLE_MIME], createRenderer: () => new DdbTableRenderer() }, 0);
  }
}

/** Mount Jupyter's output widget inside a React-owned execution-history entry. */
export function NativeOutput({ entry, rendermime }: { entry: OutputEntry; rendermime: IRenderMimeRegistry }): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null);
  const adapter = React.useRef<OutputAdapter>();
  React.useLayoutEffect(() => {
    const model = new OutputAreaModel({ trusted: false });
    const area = new SimplifiedOutputArea({ model, rendermime });
    adapter.current = new OutputAdapter(model);
    Widget.attach(area, host.current!);
    return () => { adapter.current = undefined; area.dispose(); model.dispose(); };
  }, [rendermime]);
  React.useLayoutEffect(() => { adapter.current?.update(entry); }, [rendermime, entry.id, entry.prints.length, entry.value, entry.error]);
  return <div ref={host} className="ddb-native-output"/>;
}

export function Result({ value, rendermime }: { value: DisplayValue; rendermime: IRenderMimeRegistry }): React.ReactElement {
  return <NativeOutput entry={{ id: 'preview', label: '', status: 'ok', prints: [], value }} rendermime={rendermime}/>;
}
