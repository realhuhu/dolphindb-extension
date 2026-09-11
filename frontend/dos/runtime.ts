import { DdbForm, DdbObj, format, formati, type DDB, type DdbVectorObj, type DdbMatrixValue, type DdbDictValue } from 'dolphindb/browser.js';
import { request, socketUrl, type SessionTicket } from '../api';
import { DdbConnection } from '../upstream/connection';
import { executeCode, funcdefs } from '../upstream/execution';
import { columnSortRanks } from './table';
import { variablePreviewScript } from '../session/variables';
import { tableSchemaScript } from '../session/schema';

export interface DatabaseEntry { path: string; tables: string[]; catalog?: string }
export interface VariableEntry {
  name: string; type: string; form: string; rows: number; columns: number;
  bytes: bigint | string; shared: boolean; value?: string;
}
export interface DisplayValue { text?: string; columns?: string[]; rows?: string[][]; totalRows?: number; totalColumns?: number; sortRanks?: (number[] | null)[] }

export async function openSdk(ticket: SessionTicket, name: string, inspectServer = true): Promise<DdbConnection> {
  const connection = new DdbConnection(socketUrl(ticket.path), name, {
    autologin: Boolean(ticket.username), username: ticket.username, password: ticket.password, verbose: false,
  });
  ticket.password = '';
  connection.ddb.print_message = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      inspectServer ? connection.connect() : connection.ddb.connect(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('连接超时，请检查连接配置。')), ticket.timeout * 1000); }),
    ]);
    return connection;
  } catch (error) {
    connection.disconnect();
    throw error;
  } finally { clearTimeout(timer); }
}

export async function previewConnection(id: string, name: string): Promise<DdbConnection> {
  return openSdk(await request<SessionTicket>('sessions', 'POST', { id }), name);
}

export async function executeInSession(connection: DdbConnection, code: string, line: number, onPrint: (text: string) => void): Promise<DdbObj> {
  const socket = connection.ddb.lwebsocket.resource;
  let closed: () => void = () => {};
  try {
    return await Promise.race([
      executeCode(connection.ddb, code, line, onPrint),
      new Promise<never>((_, reject) => {
        closed = () => reject(new Error('会话连接已断开；代码未自动重试。'));
        socket?.addEventListener('close', closed);
      }),
    ]);
  } finally { socket?.removeEventListener('close', closed); }
}

/** Same metadata queries as upstream connector.update_databases, including empty databases. */
export async function loadDatabases(connection: DdbConnection): Promise<DatabaseEntry[]> {
  const ddb = connection.ddb;
  const [tables, databases] = await Promise.all([
    ddb.invoke<string[]>('getClusterDFSTables'),
    ddb.invoke<string[]>('getClusterDFSDatabases').catch(() => [] as string[]),
  ]);
  const entries = new Map<string, DatabaseEntry>();
  for (const path of databases) { entries.set(path.replace(/\/$/, ''), { path: path.replace(/\/$/, ''), tables: [] }); }
  for (const table of tables) {
    const path = table.slice(0, table.lastIndexOf('/'));
    const name = table.slice(table.lastIndexOf('/') + 1);
    const entry = entries.get(path) ?? { path, tables: [] };
    entry.tables.push(name);
    entries.set(path, entry);
  }
  if (connection.version.startsWith('3.')) {
    const catalogs = await ddb.invoke<string[]>('getAllCatalogs').catch(() => []);
    for (const catalog of catalogs) {
      const schemas = await ddb.invoke<{ schema: string; dbUrl: string }[]>('getSchemaByCatalog', [catalog]).catch(() => []);
      for (const schema of schemas) {
        const entry = entries.get(schema.dbUrl);
        if (entry) { entry.catalog = `${catalog}.${schema.schema}`; }
      }
    }
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Upstream only fetches scalar/pair values: fetching mutable values loses their ownership. */
export async function loadVariables(ddb: DDB): Promise<VariableEntry[]> {
  const variables = (await ddb.invoke<VariableEntry[]>('objs', [true]))
    .filter(v => !['pnode_run', 'invoke', 'jsrpc', ...Object.keys(funcdefs)].includes(v.name));
  const immutables = variables.filter(v => v.form === 'SCALAR' || v.form === 'PAIR');
  if (immutables.length) {
    const values = await ddb.eval<DdbObj<DdbObj[]>>(
      `(${immutables.map(v => `objByName(${JSON.stringify(v.name)})`).join(',')},0)`
    );
    immutables.forEach((v, i) => {
      const obj = values.value[i];
      v.value = (obj.form === DdbForm.pair
        ? `[${formati(obj as DdbVectorObj, 0, { colors: false })}, ${formati(obj as DdbVectorObj, 1, { colors: false })}]`
        : format(obj.type, obj.value, obj.le, { colors: false })).slice(0, 300);
    });
  }
  return variables;
}

export function displayValue(obj: DdbObj, maxRows = 100): DisplayValue {
  if (obj.form === DdbForm.table) {
    const columns = obj.value as DdbVectorObj[];
    const rows: string[][] = [];
    for (let row = 0; row < Math.min(obj.rows ?? 0, maxRows); row++) {
      rows.push(columns.map(column => formati(column, row, { quote: false, nullstr: true }).slice(0, 2000)));
    }
    return { columns: columns.map(c => c.name ?? ''), rows, totalRows: obj.rows,
      sortRanks: columns.map(column => columnSortRanks(column, rows.length)) };
  }
  return { text: obj.toString().slice(0, 20_000) };
}

export async function tablePreview(connection: DdbConnection, database: string, table: string): Promise<DisplayValue> {
  const ddb = connection.ddb;
  return displayValue(await ddb.call(await ddb.define(funcdefs.peek_table.dolphindb), [database, table]));
}

export async function tableSchema(connection: DdbConnection, database: string, table: string): Promise<DisplayValue> {
  return displayValue(await connection.ddb.eval(tableSchemaScript(database, table)));
}

/** Keep structured values structured, using the same table renderer as execution results. */
export function variableDisplayValue(obj: DdbObj): DisplayValue {
  const count = Math.min(obj.rows ?? 0, 10);
  const cell = (vector: DdbVectorObj, index: number) => formati(vector, index, { colors: false, grouping: false, nullstr: true, quote: false }).slice(0, 2000);
  if (obj.form === DdbForm.table) {
    const columns = (obj.value as DdbVectorObj[]).slice(0, 8);
    return { columns: columns.map(column => column.name ?? ''),
      rows: Array.from({ length: count }, (_, row) => columns.map(column => cell(column, row))),
      totalRows: obj.rows, totalColumns: (obj.value as DdbVectorObj[]).length,
      sortRanks: columns.map(column => columnSortRanks(column, count)) };
  }
  if (obj.form === DdbForm.vector || obj.form === DdbForm.pair || obj.form === DdbForm.set) {
    const vector = obj as DdbVectorObj;
    return { columns: ['索引', '值'], rows: Array.from({ length: count }, (_, row) => [String(row), cell(vector, row)]),
      totalRows: obj.rows, sortRanks: [Array.from({ length: count }, (_, row) => row), columnSortRanks(vector, count)] };
  }
  if (obj.form === DdbForm.dict) {
    const [keys, values] = obj.value as DdbDictValue;
    const size = Math.min(keys.rows ?? 0, 10);
    return { columns: ['键', '值'], rows: Array.from({ length: size }, (_, row) => [cell(keys, row), cell(values, row)]),
      totalRows: keys.rows, sortRanks: [columnSortRanks(keys, size), columnSortRanks(values, size)] };
  }
  if (obj.form === DdbForm.matrix) {
    // Read column-major storage without converting INT64/Decimal values to JS numbers.
    const matrix = obj.value as DdbMatrixValue;
    const flat = new DdbObj<DdbMatrixValue['data']>({ form: DdbForm.vector, type: obj.type, value: matrix.data, rows: obj.rows! * obj.cols!, le: obj.le });
    const columns = Array.from({ length: Math.min(obj.cols!, 8) }, (_, col) => col);
    const ranks = columnSortRanks(flat, flat.rows!);
    return { columns: ['索引', ...columns.map(col => matrix.cols ? cell(matrix.cols, col) : String(col))],
      rows: Array.from({ length: count }, (_, row) => [matrix.rows ? cell(matrix.rows, row) : String(row),
        ...columns.map(col => cell(flat, col * obj.rows! + row))]),
      totalRows: obj.rows, totalColumns: obj.cols! + 1,
      sortRanks: [matrix.rows ? columnSortRanks(matrix.rows, count) : Array.from({ length: count }, (_, row) => row),
        ...columns.map(col => Array.from({ length: count }, (_, row) => ranks[col * obj.rows! + row]))] };
  }
  const text = obj.form === DdbForm.scalar ? format(obj.type, obj.value, obj.le, { colors: false, grouping: false, nullstr: true, quote: true })
    : obj.form === DdbForm.object ? String(obj.value) : obj.toString({ colors: false, nullstr: true, quote: true });
  return { text: text.length > 8_000 ? `${text.slice(0, 8_000)}\n…` : text };
}

/** Same owning-session and size guard as VS Code's DdbVar.resolve_tooltip. */
export async function variablePreview(ddb: DDB, name: string): Promise<DisplayValue> {
  return variableDisplayValue(await ddb.eval(variablePreviewScript(name)));
}

export async function tableColumns(ddb: DDB, table: string): Promise<string[]> {
  const schema = await ddb.invoke<{ colDefs: { name: string }[] }>(
    await ddb.define(funcdefs.load_table_variable_schema.dolphindb), [table]
  );
  return schema.colDefs.map(c => c.name);
}
