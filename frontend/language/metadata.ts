import type { DosModel } from '../dos/model';
import type { MetadataRequest } from './contracts';
import { tableReference } from './regions';

export type RuntimeVariable = { name: string; form: string; type: string };
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** Same database interface as the upstream language service, scoped to one document/session. */
export class MetadataDatabase {
  dfsDatabases: string[] = [];
  catalogs: string[] = [];
  sharedTables: string[] = [];
  variables: RuntimeVariable[] = [];
  dbTables = new Map<string, string[]>();
  constructor(readonly request: MetadataRequest) {}
  async refresh(): Promise<void> {
    const data = await this.request('snapshot', {}).catch(() => null) as null | Record<string, unknown>;
    if (!data) { return; }
    this.dfsDatabases = strings(data.databases); this.catalogs = strings(data.catalogs);
    this.sharedTables = strings(data.sharedTables);
    this.variables = Array.isArray(data.variables) ? data.variables.filter(v => v && typeof v.name === 'string' && typeof v.form === 'string') : [];
  }
  async update_table_of_db(database: string): Promise<void> {
    this.dbTables.set(database, strings(await this.request('tables', { database }).catch(() => [])));
  }
  async getColnames(reference: string): Promise<string[]> {
    const target = tableReference(reference);
    return target ? strings(await this.request('columns', target).catch(() => [])) : [];
  }
  async getSchemasByCatalog(catalog: string): Promise<string[]> {
    return strings(await this.request('schemas', { catalog }).catch(() => []));
  }
  async getTablesByCatalogAndSchema(catalog: string, schema: string): Promise<string[]> {
    return strings(await this.request('schemaTables', { kind: 'catalog', catalog, schema }).catch(() => []));
  }
}

export function dosMetadata(model: DosModel): MetadataRequest {
  return async (operation, args) => {
    const ddb = model.sdk?.ddb;
    if (!ddb?.connected || model.executing) { throw new Error('DDB 会话暂不可用。'); }
    if (operation === 'snapshot') {
      const [variables, databases, catalogs] = await Promise.all([
        ddb.invoke<RuntimeVariable[]>('objs', [true]),
        ddb.invoke<string[]>('getClusterDFSDatabases').catch(() => []),
        ddb.invoke<string[]>('getAllCatalogs').catch(() => []),
      ]);
      return { variables, databases, catalogs, sharedTables: variables.filter(v => v.form === 'TABLE').map(v => v.name) };
    }
    if (operation === 'tables') { return (await ddb.invoke<{ tableName: string }[]>('listTables', [args.database])).map(v => v.tableName); }
    const schemas = async () => ddb.invoke<{ schema: string; dbUrl: string }[]>('getSchemaByCatalog', [args.catalog]);
    if (operation === 'schemas') { return (await schemas()).map(v => v.schema); }
    if (operation === 'schemaTables') {
      const db = (await schemas()).find(v => v.schema === args.schema)?.dbUrl;
      return db ? (await ddb.invoke<{ tableName: string }[]>('listTables', [db])).map(v => v.tableName) : [];
    }
    if (operation === 'columns') {
      let reference: string;
      if (args.kind === 'variable') { reference = `objByName(${JSON.stringify(args.name)})`; }
      else {
        const db = args.kind === 'dfs' ? args.database : (await schemas()).find(v => v.schema === args.schema)?.dbUrl;
        if (!db) { return []; }
        reference = `loadTable(${JSON.stringify(db)}, ${JSON.stringify(args.table)})`;
      }
      return ddb.execute<string[]>(`schema(${reference}).colDefs.name`);
    }
    throw new Error('Unsupported metadata operation');
  };
}
