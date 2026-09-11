import type { VariableEntry } from '../dos/runtime';

/** Adapted from upstream src/variables.ts: location, form order and hover size limit. */
export const VARIABLE_PREVIEW_LIMIT = 10_240n;
const forms = [
  ['SCALAR', '标量'], ['SYSOBJ', '对象'], ['PAIR', '数对'], ['VECTOR', '向量'],
  ['SET', '集合'], ['DICTIONARY', '词典'], ['MATRIX', '矩阵'], ['TABLE', '表格'],
  ['CHART', '绘图'], ['CHUNK', '数据块'], ['TENSOR', '张量'],
] as const;

export function variableForm(form: string): string {
  const upper = form.toUpperCase();
  return upper === 'DICT' ? 'DICTIONARY' : upper === 'OBJECT' ? 'SYSOBJ' : upper;
}

export function memoryBytes(value: VariableEntry['bytes']): bigint {
  try { const bytes = BigInt(value); return bytes > 0n ? bytes : 0n; } catch { return 0n; }
}

export function formatBytes(value: VariableEntry['bytes']): string {
  const bytes = memoryBytes(value);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let divisor = 1n, unit = 0;
  while (unit < units.length - 1 && bytes >= divisor * 1024n) { divisor *= 1024n; unit++; }
  if (!unit) { return `${bytes} B`; }
  // Keep the byte count as an integer, including values beyond Number.MAX_SAFE_INTEGER.
  const hundredths = (bytes * 100n + divisor / 2n) / divisor;
  return `${hundredths / 100n}${hundredths % 100n ? `.${String(hundredths % 100n).padStart(2, '0').replace(/0$/, '')}` : ''} ${units[unit]}`;
}

export function totalBytes(variables: readonly VariableEntry[]): bigint {
  return variables.reduce((sum, variable) => sum + memoryBytes(variable.bytes), 0n);
}

export interface VariableGroup {
  key: string;
  label: string;
  variables: VariableEntry[];
  bytes: bigint;
}
export interface VariableLocation extends VariableGroup { groups: VariableGroup[] }

export function groupVariables(variables: readonly VariableEntry[], filter = ''): VariableLocation[] {
  const query = filter.trim().toLocaleLowerCase();
  const result: VariableLocation[] = [];
  for (const shared of [false, true]) {
    const selected = variables.filter(v => v.shared === shared && v.name.toLocaleLowerCase().includes(query));
    if (!selected.length) { continue; }
    const byForm = new Map<string, VariableEntry[]>();
    for (const variable of selected) {
      const form = variableForm(variable.form);
      const group = byForm.get(form) ?? [];
      group.push(variable); byForm.set(form, group);
    }
    const groups: VariableGroup[] = [];
    for (const [form, label] of [...forms, ...[...byForm.keys()].filter(form => !forms.some(([key]) => key === form)).map(form => [form, form])]) {
      const entries = byForm.get(form);
      if (!entries) { continue; }
      if (form === 'TABLE') { entries.sort((a, b) => a.name.localeCompare(b.name)); }
      groups.push({ key: form, label, variables: entries, bytes: totalBytes(entries) });
    }
    result.push({ key: shared ? 'shared' : 'local', label: shared ? '共享变量' : '本地变量',
      variables: selected, groups, bytes: totalBytes(selected) });
  }
  return result;
}

export function variableDescription(variable: VariableEntry): string {
  const { type, rows, columns, value } = variable;
  const count = rows.toLocaleString('zh-CN'), cols = columns.toLocaleString('zh-CN');
  switch (variableForm(variable.form)) {
    case 'SCALAR': case 'PAIR': return `<${type}>${value === undefined ? '' : ` = ${value}`}`;
    case 'VECTOR': case 'SET': return `<${type}> ${count} 个元素`;
    case 'DICTIONARY': return `${count} 个键`;
    case 'TABLE': return `${count} 行 × ${cols} 列`;
    case 'MATRIX': return `<${type}> ${count} 行 × ${cols} 列`;
    default: return `<${type}>`;
  }
}

/** One top-level evaluation checks the live size before returning a single object.
 * Never wrap mutable values in an ANY vector: that strips their ownership.
 */
export function variablePreviewScript(name: string, limit = Number(VARIABLE_PREVIEW_LIMIT)): string {
  if (!Number.isInteger(limit) || limit < 1024 || limit > 1048576) { throw new Error('变量预览大小上限无效。'); }
  const literal = JSON.stringify(name);
  return `if ((exec count(*) from objs(true) where name = ${literal}) == 0) throw "变量已不存在，请刷新变量面板。";\n`
    + `if ((exec first(bytes) from objs(true) where name = ${literal}) > ${limit}) throw "变量超过 ${formatBytes(BigInt(limit))}，请刷新变量面板。";\n`
    + `objByName(${literal})`;
}
