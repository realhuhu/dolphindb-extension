import type { DisplayValue } from '../dos/runtime';

export const DATA_MIME = 'application/vnd.dolphindb.data+json';
// Only ddb_show emits this MIME. Legacy automatic Notebook outputs stay native.
export const SHOW_MIME = 'application/vnd.dolphindb.view+json';
export type DataTarget = { kind: 'variable' | 'variable-schema'; name: string } | { kind: 'table' | 'schema'; database: string; table: string }
  | { kind: 'database-schema'; database: string } | { kind: 'result'; id: string };
export interface BrowseRequest { path: number[]; offset: number; limit: number; columnOffset: number; columnLimit?: number; revision?: number }
export const FIRST_PAGE: BrowseRequest = { path: [], offset: 0, limit: 100, columnOffset: 0 };
export interface ChartData {
  type: number; titles: { chart: string; x_axis: string; y_axis: string; z_axis?: string };
  stacking: boolean; multiY: boolean; rowLabels: (string | number)[]; columnLabels: string[];
  values: (number | null)[][]; binCount?: number; binStart?: number; binEnd?: number;
}
export interface DataPage {
  form: string; type: string; count: number; columnCount?: number; shape?: number[];
  grid?: DisplayValue; text?: string; numeric?: boolean; chart?: ChartData;
  children?: { index: number; label: string; description: string }[];
}
export interface DataTicket { owner: string; target: DataTarget; title: string; initial: DataPage; initialRequest?: BrowseRequest }
export interface DataSource { title: string; read(request: BrowseRequest): Promise<DataPage> }

/** Requests are also checked in the kernel; offsets and paths never contain code. */
export function browseRequest(input: Partial<BrowseRequest>): BrowseRequest {
  const integer = (n: unknown, max: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max;
  if (!Array.isArray(input.path) || input.path.length > 32 || !input.path.every(n => integer(n, Number.MAX_SAFE_INTEGER))
    || !integer(input.offset, Number.MAX_SAFE_INTEGER) || !integer(input.columnOffset, Number.MAX_SAFE_INTEGER)
    || !integer(input.limit, 1000) || !input.limit || input.columnLimit !== undefined && (!integer(input.columnLimit, 200) || !input.columnLimit)
    || input.revision !== undefined && !integer(input.revision, Number.MAX_SAFE_INTEGER)) { throw new Error('数据浏览请求无效。'); }
  return { path: [...input.path], offset: input.offset!, limit: input.limit, columnOffset: input.columnOffset!, columnLimit: input.columnLimit ?? 50, revision: input.revision ?? 0 };
}

/** Saved notebook MIME data is untrusted; validate before giving it to React/charts. */
export function dataTicket(input: unknown): DataTicket | null {
  const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value: unknown) => typeof value === 'string';
  const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  if (!record(input) || !text(input.owner) || !text(input.title) || !record(input.target) || input.target.kind !== 'result' || !text(input.target.id)) { return null; }
  if (input.initialRequest !== undefined) {
    try { const initial = browseRequest(input.initialRequest); if (initial.path.length || initial.offset || initial.columnOffset || initial.revision) { return null; } }
    catch { return null; }
  }
  const page = input.initial;
  if (!record(page) || !text(page.form) || !text(page.type) || !count(page.count)
    || page.columnCount !== undefined && !count(page.columnCount)
    || page.text !== undefined && !text(page.text)
    || page.numeric !== undefined && typeof page.numeric !== 'boolean'
    || page.shape !== undefined && (!Array.isArray(page.shape) || !page.shape.every(count))) { return null; }
  if (page.children !== undefined && (!Array.isArray(page.children) || page.children.length > 1000
    || !page.children.every((child: unknown) => record(child) && count(child.index) && text(child.label) && text(child.description)))) { return null; }
  if (page.grid !== undefined) {
    const grid = page.grid;
    if (!record(grid) || !Array.isArray(grid.columns) || grid.columns.length > 201 || !grid.columns.every(text)
      || !Array.isArray(grid.rows) || grid.rows.length > 1000 || !grid.rows.every((row: unknown) => Array.isArray(row) && row.length === grid.columns.length && row.every(text))
      || grid.columnTypes !== undefined && (!Array.isArray(grid.columnTypes) || grid.columnTypes.length !== grid.columns.length || !grid.columnTypes.every(text))
      || grid.sortRanks !== undefined && (!Array.isArray(grid.sortRanks) || grid.sortRanks.length !== grid.columns.length
        || !grid.sortRanks.every((ranks: unknown) => ranks === null || Array.isArray(ranks) && ranks.length === grid.rows.length && ranks.every(count)))) { return null; }
  }
  if (page.chart !== undefined) {
    const chart = page.chart, label = (value: unknown) => text(value) || typeof value === 'number' && Number.isFinite(value);
    if (!record(chart) || !count(chart.type) || !record(chart.titles) || !['chart', 'x_axis', 'y_axis'].every(key => text(chart.titles[key]))
      || chart.titles.z_axis !== undefined && !text(chart.titles.z_axis)
      || typeof chart.stacking !== 'boolean' || typeof chart.multiY !== 'boolean'
      || !Array.isArray(chart.rowLabels) || !chart.rowLabels.every(label) || !Array.isArray(chart.columnLabels) || !chart.columnLabels.every(text)
      || !Array.isArray(chart.values) || chart.values.length !== chart.rowLabels.length
      || !chart.values.every((row: unknown) => Array.isArray(row) && row.length === chart.columnLabels.length && row.every(n => n === null || typeof n === 'number' && Number.isFinite(n)))
      || !['binCount', 'binStart', 'binEnd'].every(key => chart[key] === undefined || typeof chart[key] === 'number' && Number.isFinite(chart[key]))) { return null; }
  }
  return input as unknown as DataTicket;
}
