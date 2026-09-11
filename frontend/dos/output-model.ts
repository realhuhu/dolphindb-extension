import type { IOutputAreaModel } from '@jupyterlab/outputarea';
import type { IOutput, IMimeBundle } from '@jupyterlab/nbformat';
import type { OutputEntry } from './model';
import type { DisplayValue } from './runtime';

export const TABLE_MIME = 'application/vnd.dolphindb.table+json';

/** Keep the typed table payload separate from HTML; the renderer escapes cell text. */
export function resultData(value: DisplayValue): IMimeBundle {
  if (!value.columns) { return { 'text/plain': value.text || '执行完成' }; }
  return {
    'text/plain': [value.columns.join('\t'), ...(value.rows ?? []).map(row => row.join('\t'))].join('\n'),
    [TABLE_MIME]: { columns: value.columns, rows: value.rows ?? [], totalRows: value.totalRows ?? value.rows?.length ?? 0,
      ...(value.sortRanks ? { sortRanks: value.sortRanks } : {}),
      ...(value.totalColumns === undefined ? {} : { totalColumns: value.totalColumns }) },
  };
}

/** Incrementally adapt SDK output to the standard Jupyter output model. */
export class OutputAdapter {
  private id = '';
  private prints = 0;
  private terminal: number | null = null;
  private value: DisplayValue | undefined;
  private error: string | undefined;
  constructor(private model: Pick<IOutputAreaModel, 'add' | 'set' | 'clear' | 'length'>) {}
  update(entry: OutputEntry): void {
    if (this.id !== entry.id || entry.prints.length < this.prints || (this.terminal !== null && entry.prints.length > this.prints)) {
      this.model.clear(); this.id = entry.id; this.prints = 0; this.terminal = null; this.value = undefined; this.error = undefined;
    }
    for (; this.prints < entry.prints.length; this.prints++) {
      this.model.add({ output_type: 'stream', name: 'stdout', text: entry.prints[this.prints] + '\n' });
    }
    if (entry.value === this.value && entry.error === this.error) { return; }
    const result: IOutput | undefined = entry.error
      ? { output_type: 'error', ename: 'DolphinDBError', evalue: entry.error, traceback: entry.error.split('\n') }
      : entry.value ? { output_type: 'display_data', data: resultData(entry.value), metadata: {} } : undefined;
    if (result) {
      if (this.terminal === null) { this.model.add(result); this.terminal = this.model.length - 1; }
      else { this.model.set(this.terminal, result); }
    }
    this.value = entry.value; this.error = entry.error;
  }
}
