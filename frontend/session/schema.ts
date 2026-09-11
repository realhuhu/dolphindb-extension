import type { DisplayValue } from '../dos/runtime';
import { loadTableExpression } from './interactions';

export function tableSchemaScript(database: string, table: string): string {
  return `schema(${loadTableExpression(database, table)}).colDefs`;
}

/** Both SDKs transport the same colDefs table; keep its column order and metadata. */
export function schemaDisplayValue(value: DisplayValue): DisplayValue {
  const fields = [['name', '字段名'], ['typeString', '类型'], ['extra', '附加信息'], ['comment', '备注']];
  if (!value.columns?.includes('name') || !value.columns.includes('typeString') || !Array.isArray(value.rows)) {
    throw new Error('无法读取表结构。');
  }
  const columns = fields.map(([name, label]) => ({ name, label, index: value.columns!.indexOf(name) }))
    .filter(column => column.index >= 0 && (column.name === 'name' || column.name === 'typeString'
      || value.rows!.some(row => !['', '0', 'null', 'None', 'nan'].includes(row[column.index]))));
  return { columns: columns.map(column => column.label), rows: value.rows.map(row => columns.map(column => row[column.index])),
    totalRows: value.totalRows, sortRanks: columns.map(column => value.sortRanks?.[column.index] ?? null) };
}
