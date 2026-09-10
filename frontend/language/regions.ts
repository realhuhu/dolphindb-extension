import type { DdbRegion, Projection } from './contracts';

/** Preserve offsets while excluding Python code, comments and string literals from DDB analysis. */
export function ddbRegions(source: string, file = false): DdbRegion[] {
  if (file) { return [{ from: 0, to: source.length, kind: 'file', header: 0 }]; }
  if (/^%%ddb(?:\s|$)/.test(source)) {
    const newline = source.indexOf('\n');
    return newline < 0 ? [] : [{ from: newline + 1, to: source.length, kind: 'cell', header: 0 }];
  }
  const regions: DdbRegion[] = [];
  let quote = '', triple = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === '\\') { i++; continue; }
      if (triple && source.slice(i, i + 3) === quote.repeat(3)) { i += 2; quote = ''; }
      else if (!triple && (char === quote || char === '\n')) { quote = ''; }
      continue;
    }
    if (char === '#') { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
    if (char === '"' || char === "'") {
      quote = char; triple = source.slice(i, i + 3) === char.repeat(3); if (triple) { i += 2; } continue;
    }
    if (char === '%' && /^%ddb(?:[ \t]|$)/.test(source.slice(i, source.indexOf('\n', i) < 0 ? undefined : source.indexOf('\n', i)))) {
      const header = source.lastIndexOf('\n', i - 1) + 1;
      const prefix = source.slice(header, i);
      if (!/^\s*(?:[\w\s,[\].]+\s*=\s*)?$/.test(prefix)) { continue; }
      const end = source.indexOf('\n', i);
      const to = end < 0 ? source.length : end;
      const from = i + 4 + (source.slice(i + 4, to).match(/^[ \t]*/)?.[0].length ?? 0);
      regions.push({ from, to, kind: 'line', header });
      i = to - 1;
    }
  }
  return regions;
}

export function projectDdb(source: string, file = false): string {
  const regions = ddbRegions(source, file);
  let result = '', start = 0;
  for (const region of regions) {
    result += source.slice(start, region.from).replace(/[^\n\r]/g, ' ');
    result += source.slice(region.from, region.to);
    start = region.to;
  }
  return result + source.slice(start).replace(/[^\n\r]/g, ' ');
}

export function openLiteral(before: string): { from: number; quote: string } | null {
  let quote = '', from = 0;
  for (let i = before.lastIndexOf('\n') + 1; i < before.length; i++) {
    const char = before[i];
    if (quote && char === '\\') { i++; continue; }
    if (quote && char === quote) { quote = ''; continue; }
    if (!quote && (char === '"' || char === "'" || char === '`')) { quote = char; from = i + 1; }
    else if (quote === '`' && !/[\w\u4e00-\u9fff]/.test(char)) { quote = ''; }
  }
  return quote ? { from, quote } : null;
}

export function projection(source: string, offset: number, file = false, previous: string[] = []): Projection | null {
  const region = ddbRegions(source, file).find(r => offset >= r.from && offset <= r.to);
  if (!region) { return null; }
  const prefix = previous.map(s => projectDdb(s) + '\n').join('');
  return { source: prefix + projectDdb(source, file), offset: prefix.length + offset, base: prefix.length, region };
}

/** Only table references are accepted for metadata; arbitrary editor expressions are never executed. */
export function tableReference(text: string): Record<string, string> | null {
  const input = text.trim();
  const identifier = '[A-Za-z_\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff]*';
  if (new RegExp(`^${identifier}$`).test(input)) { return { kind: 'variable', name: input }; }
  if (new RegExp(`^${identifier}\\.${identifier}\\.${identifier}$`).test(input)) {
    const [catalog, schema, table] = input.split('.'); return { kind: 'catalog', catalog, schema, table };
  }
  const load = /^loadTable\(\s*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))\s*,\s*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`\w+))\s*\)$/.exec(input);
  const unquote = (value: string) => value.startsWith('`') ? value.slice(1)
    : value.startsWith('"') ? JSON.parse(value) as string : value.slice(1, -1).replace(/\\(['\\])/g, '$1');
  if (load) { try { return { kind: 'dfs', database: unquote(load[1]), table: unquote(load[2]) }; } catch { return null; } }
  const qualified = /^((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))\s*\.\s*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`\w+|\w+))$/.exec(input);
  if (qualified) {
    try { return { kind: 'dfs', database: unquote(qualified[1]), table: /^["'`]/.test(qualified[2]) ? unquote(qualified[2]) : qualified[2] }; } catch { return null; }
  }
  return null;
}
