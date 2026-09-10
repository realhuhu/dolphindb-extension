import { DdbForm, DdbObj, formati, type DDB, type DdbVectorObj } from 'dolphindb/browser.js';
import { request, socketUrl, type SessionTicket } from '../api';
import { DdbConnection } from '../upstream/connection';
import { executeCode, funcdefs } from '../upstream/execution';

export interface DatabaseEntry { path: string; tables: string[]; catalog?: string }
export interface VariableEntry {
  name: string; type: string; form: string; rows: number; columns: number;
  bytes: bigint; shared: boolean; value?: string;
}
export interface DisplayValue { text?: string; columns?: string[]; rows?: string[][]; totalRows?: number }

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
    immutables.forEach((v, i) => { v.value = values.value[i].toString().slice(0, 300); });
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
    return { columns: columns.map(c => c.name ?? ''), rows, totalRows: obj.rows };
  }
  return { text: obj.toString().slice(0, 20_000) };
}

export async function tablePreview(connection: DdbConnection, database: string, table: string): Promise<DisplayValue> {
  const ddb = connection.ddb;
  return displayValue(await ddb.call(await ddb.define(funcdefs.peek_table.dolphindb), [database, table]));
}

export async function tableColumns(ddb: DDB, table: string): Promise<string[]> {
  const schema = await ddb.invoke<{ colDefs: { name: string }[] }>(
    await ddb.define(funcdefs.load_table_variable_schema.dolphindb), [table]
  );
  return schema.colDefs.map(c => c.name);
}
