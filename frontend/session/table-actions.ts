import { FIRST_PAGE } from '../data/types';
import type { WorkspaceModel } from './types';
import { loadTableExpression } from './interactions';

export const TABLE_ACTIONS = ['select', 'update', 'delete', 'truncate', 'load', 'schema'] as const;
export type TableAction = typeof TABLE_ACTIONS[number];
export interface TableDefinition { columns: string[]; partitionColumns: string[] }

/** Port of upstream commands.ts table_action/get_clause; only insert, never execute. */
export function tableStatement(action: TableAction, database: string, table: string, definition: TableDefinition = { columns: [], partitionColumns: [] }, catalog?: string): string {
  const expression = loadTableExpression(database, table);
  if (action === 'load') { return expression; }
  if (action === 'schema') { return `schema(${expression})`; }
  if (action === 'truncate') { return `truncate(${JSON.stringify(database)}, ${JSON.stringify(table)})`; }
  const identifier = (name: string) => /^[A-Za-z_]\w*$/.test(name) ? name : `_${JSON.stringify(name)}`;
  const target = catalog && catalog.split('.').every(part => /^[A-Za-z_]\w*$/.test(part)) && /^[A-Za-z_]\w*$/.test(table)
    ? `${catalog}.${table}` : expression;
  const partitions = definition.partitionColumns.length ? definition.partitionColumns : definition.columns.slice(0, 1);
  const where = partitions.length ? ` where ${partitions.map(name => `${identifier(name)}=`).join(' and ')}` : '';
  return action === 'update' ? `update ${target} set ${definition.columns.map(name => `${identifier(name)}=`).join(', ')}${where}`
    : `${action}${action === 'select' ? ' *' : ''} from ${target}${where}`;
}

export async function tableDefinition(model: WorkspaceModel, database: string, table: string): Promise<TableDefinition> {
  const target = { kind: 'schema' as const, database, table };
  const schema = await model.browse(target, FIRST_PAGE);
  const columns: string[] = [], partitionColumns: string[] = [];
  const field = schema.children?.find(child => child.label === 'colDefs');
  if (!field) { throw new Error('无法读取表字段。'); }
  for (let offset = 0; ; offset += 1000) {
    const page = await model.browse(target, { ...FIRST_PAGE, path: [field.index], offset, limit: 1000 });
    const index = page.grid?.columns?.indexOf('name') ?? -1;
    if (index < 0) { throw new Error('无法读取表字段名称。'); }
    columns.push(...page.grid!.rows!.map(row => row[index]));
    if (offset + 1000 >= page.count) { break; }
  }
  const partition = schema.children?.find(child => child.label === 'partitionColumnName');
  if (partition) {
    const page = await model.browse(target, { ...FIRST_PAGE, path: [partition.index] });
    if (page.text && page.text !== 'null') { partitionColumns.push(page.text); }
    else { partitionColumns.push(...(page.grid?.rows?.map(row => row[1]) ?? [])); }
  }
  return { columns, partitionColumns };
}
