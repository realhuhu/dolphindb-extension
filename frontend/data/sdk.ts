import { DdbObj, DdbForm, DdbType, ddb_tensor_bytes, formati, format,
  type DdbVectorObj, type DdbDictValue, type DdbMatrixValue, type DdbTensorValue, type DdbChartValue, type DdbArrayVectorValue } from 'dolphindb/browser.js';
import type { DdbConnection } from '../upstream/connection';
import { NodeType } from '../upstream/commons';
import { columnSortRanks } from '../dos/table';
import { browseRequest, type BrowseRequest, type DataPage, type DataTarget, type ChartData } from './types';
import { numericType } from './format';
import { ddbTypeName, ddbFormName } from './names';

const options = { colors: false, grouping: false, quote: false, nullstr: true };
const cell = (v: DdbVectorObj, i: number) => formati(v, i, options);
const typeName = (obj: DdbObj) => ddbTypeName(obj.type);
const label = (obj: DdbObj) => `${ddbFormName(obj.form)} <${typeName(obj)}> ${obj.rows ?? 1}${obj.cols ? ` × ${obj.cols}` : ''}`;
const scalarPage = (v: DdbVectorObj, i: number): DataPage => ({ form: 'SCALAR', type: typeName(v), count: 1,
  text: cell(v, i), numeric: numericType(typeName(v)) });
const isArrayVector = (v: DdbObj) => v.type >= 64 && v.type < 128;

/** Slice the SDK's typed blocks instead of converting array vectors through JS numbers. */
function arrayElement(vector: DdbVectorObj, index: number): DdbVectorObj {
  const blocks = vector.value as DdbArrayVectorValue, type = vector.type - 64;
  for (const block of blocks) {
    if (index >= block.rows) { index -= block.rows; continue; }
    const start = Array.from(block.lengths).slice(0, index).reduce((sum, length) => sum + length, 0), rows = block.lengths[index];
    const width = [DdbType.complex, DdbType.point].includes(type as any) ? 2 : [DdbType.uuid, DdbType.int128, DdbType.ipaddr].includes(type as any) ? 16 : 1;
    const data = block.data.subarray(start * width, (start + rows) * width);
    return new DdbObj({ form: DdbForm.vector, type, le: vector.le, rows,
      value: blocks.scale === undefined ? data : { scale: blocks.scale, data } } as DdbVectorObj);
  }
  throw new Error('数组元素已不存在。');
}

/** Official SDK retains types, null sentinels, column-major matrices and tensor strides. */
export function objectPage(root: DdbObj, input: BrowseRequest): DataPage {
  const request = browseRequest(input);
  let obj = root;
  for (let depth = 0; depth < request.path.length; depth++) {
    if (obj.form === DdbForm.tensor) { return tensorPage(obj, { ...request, path: request.path.slice(depth) }); }
    const index = request.path[depth];
    const vector = obj.form === DdbForm.dict ? (obj.value as DdbDictValue)[1] : obj as DdbVectorObj;
    if (obj.form === DdbForm.table) {
      obj = (obj.value as DdbVectorObj[])[index];
      if (!obj) { throw new Error('列已不存在。'); }
    } else if ([DdbForm.dict, DdbForm.vector, DdbForm.pair, DdbForm.set].includes(obj.form as any)) {
      if (index >= (vector.rows ?? 0)) { throw new Error('元素已不存在。'); }
      if (isArrayVector(vector)) { obj = arrayElement(vector, index); continue; }
      if (vector.type !== DdbType.any) {
        if (depth !== request.path.length - 1) { throw new Error('标量不能继续展开。'); }
        return scalarPage(vector, index);
      }
      obj = (vector.value as DdbObj[])[index];
    } else { throw new Error('此对象没有子元素。'); }
  }
  const { offset, limit, columnOffset } = request;
  const count = obj.rows ?? 1;
  const page: DataPage = { form: ddbFormName(obj.form), type: typeName(obj), count };
  if (obj.form === DdbForm.tensor) { return tensorPage(obj, { ...request, path: [] }); }
  if (obj.form === DdbForm.chart) { return { ...page, count: 1, chart: chartData(obj as DdbObj<DdbChartValue>) }; }
  if (obj.form === DdbForm.table || obj.form === DdbForm.matrix) {
    const matrix = obj.form === DdbForm.matrix ? obj.value as DdbMatrixValue : null;
    const total = matrix ? obj.cols! : (obj.value as DdbVectorObj[]).length;
    const ids = Array.from({ length: Math.max(0, Math.min(request.columnLimit!, total - columnOffset)) }, (_, n) => n + columnOffset);
    const flat = matrix ? new DdbObj<DdbMatrixValue['data']>({ form: DdbForm.vector, type: obj.type, le: obj.le, value: matrix.data, rows: count * total }) : null;
    const vectors = matrix ? ids.map(() => flat!) : ids.map(i => (obj.value as DdbVectorObj[])[i]);
    const rowCount = Math.max(0, Math.min(limit, count - offset));
    const names = ids.map(i => matrix ? matrix.cols ? cell(matrix.cols, i) : String(i) : (obj.value as DdbVectorObj[])[i].name ?? String(i));
    page.columnCount = total;
    page.grid = { columns: ['索引', ...names], columnTypes: ['INT', ...vectors.map(typeName)],
      rows: Array.from({ length: rowCount }, (_, r) => [matrix?.rows ? cell(matrix.rows, offset + r) : String(offset + r),
        ...vectors.map((v, c) => cell(v, offset + r + (matrix ? count * ids[c] : 0)))]),
      totalRows: count, totalColumns: total + 1,
      sortRanks: [Array.from({ length: rowCount }, (_, i) => i), ...vectors.map((v, c) => columnSortRanks(v, rowCount, offset + (matrix ? count * ids[c] : 0)))] };
    if (!matrix) { page.children = ids.map(i => ({ index: i, label: (obj.value as DdbVectorObj[])[i].name ?? String(i), description: label((obj.value as DdbVectorObj[])[i]) })); }
    return page;
  }
  if ([DdbForm.vector, DdbForm.pair, DdbForm.set, DdbForm.dict].includes(obj.form as any)) {
    const dict = obj.form === DdbForm.dict ? obj.value as DdbDictValue : null;
    const vector = dict ? dict[1] : obj as DdbVectorObj;
    const size = dict ? dict[0].rows! : count;
    const n = Math.max(0, Math.min(limit, size - offset));
    page.count = size;
    page.grid = { columns: [dict ? '键' : '索引', '值'], columnTypes: [dict ? typeName(dict[0]) : 'INT', typeName(vector)],
      rows: Array.from({ length: n }, (_, r) => [dict ? cell(dict[0], offset + r) : String(offset + r), cell(vector, offset + r)]), totalRows: size,
      sortRanks: [dict ? columnSortRanks(dict[0], n, offset) : Array.from({ length: n }, (_, i) => i), columnSortRanks(vector, n, offset)] };
    if (dict || vector.type === DdbType.any || isArrayVector(vector)) {
      page.children = Array.from({ length: n }, (_, r) => ({ index: offset + r, label: page.grid!.rows![r][0],
        description: vector.type === DdbType.any ? label((vector.value as DdbObj[])[offset + r]) : isArrayVector(vector) ? typeName(vector) : cell(vector, offset + r) }));
    }
    return page;
  }
  return { ...page, text: obj.form === DdbForm.scalar ? format(obj.type, obj.value, obj.le, options) : obj.toString(options), numeric: numericType(page.type) };
}

function tensorPage(obj: DdbObj, request: BrowseRequest): DataPage {
  const { shape, strides, data, data_type: type } = obj.value as DdbTensorValue;
  const path = request.path;
  if (path.length >= shape.length || path.some((index, dim) => index >= shape[dim])) { throw new Error('张量索引超出范围。'); }
  const dimension = path.length, count = shape[dimension], bytes = (ddb_tensor_bytes as Record<number, number>)[type];
  if (!bytes) { throw new Error('不支持的张量元素类型。'); }
  const start = path.reduce((sum, index, dim) => sum + strides[dim] * index, 0);
  const page: DataPage = { form: 'TENSOR', type: ddbTypeName(type), shape, count };
  const indexes = Array.from({ length: Math.max(0, Math.min(request.limit, count - request.offset)) }, (_, n) => n + request.offset);
  if (dimension < shape.length - 1) {
    page.children = indexes.map(index => ({ index, label: `[${index}]`, description: `${page.type}[${shape.slice(dimension + 1).join('][')}]` }));
  } else {
    const values = indexes.map(index => {
      const offset = (start + index * strides[dimension]) * bytes;
      const view = new DataView(data.buffer, data.byteOffset + offset, bytes);
      const n = type === DdbType.double ? view.getFloat64(0, obj.le) : type === DdbType.float ? view.getFloat32(0, obj.le)
        : type === DdbType.long ? view.getBigInt64(0, obj.le) : type === DdbType.int ? view.getInt32(0, obj.le)
          : type === DdbType.short ? view.getInt16(0, obj.le) : view.getInt8(0);
      return format(type, n, obj.le, options);
    });
    page.grid = { columns: ['索引', '值'], columnTypes: ['INT', page.type], rows: indexes.map((index, n) => [String(index), values[n]]), totalRows: count };
  }
  return page;
}

export function chartData(obj: DdbObj<DdbChartValue>): ChartData {
  const { data: matrix, titles, type, stacking, extras, bin_count, bin_start, bin_end } = obj.value;
  const { rows: rowLabels, cols: columnLabels, data } = matrix.value;
  const flat = new DdbObj<DdbMatrixValue['data']>({ form: DdbForm.vector, type: matrix.type, value: data, le: matrix.le, rows: matrix.rows! * matrix.cols! });
  const number = (text: string) => text === 'null' || !Number.isFinite(Number(text)) ? null : Number(text);
  return { type, titles, stacking, multiY: extras?.multi_y_axes ?? false,
    rowLabels: Array.from({ length: matrix.rows! }, (_, row) => rowLabels ? cell(rowLabels, row) : row),
    columnLabels: Array.from({ length: matrix.cols! }, (_, col) => columnLabels ? cell(columnLabels, col) : String(col)),
    values: Array.from({ length: matrix.rows! }, (_, row) => Array.from({ length: matrix.cols! }, (_, col) => number(cell(flat, row + col * matrix.rows!)))),
    binCount: bin_count ? Number(bin_count.value) : undefined, binStart: bin_start ? Number(bin_start.value) : undefined, binEnd: bin_end ? Number(bin_end.value) : undefined };
}

export function targetExpression(target: DataTarget): string {
  if (target.kind === 'variable' || target.kind === 'variable-schema') { const expression = `objByName(${JSON.stringify(target.name)})`; return target.kind === 'variable-schema' ? `schema(${expression})` : expression; }
  if (target.kind === 'database-schema') { return `schema(database(${JSON.stringify(target.database)}))`; }
  if (target.kind === 'table' || target.kind === 'schema') {
    const expression = `loadTable(${JSON.stringify(target.database)}, ${JSON.stringify(target.table)})`;
    return target.kind === 'schema' ? `schema(${expression})` : expression;
  }
  throw new Error('未知浏览对象。');
}

function metadataQuery(expression: string): string {
  // A DFS handle reports size() == 0 even when its partitions contain rows.
  return `(def(x){f=form(x);r=1;c=0;if(f in [1,2,4,5]){r=size(x)};if(f==3){r=rows(x);c=cols(x)};if(f==6){r=exec count(*) from x;c=cols(x)};return [long(f),long(r),long(c),long(type(x))]})(${expression})`;
}

function tableQuery(expression: string, offset: number, limit: number, firstColumn: number, endColumn: number): string {
  // sqlCol quotes actual column names; sql's limit pair is [start, end), not [offset, count].
  // Keep the range nonempty so empty tables still return their column definitions.
  return `(def(t){return sql(select=sqlCol(columnNames(t)[${firstColumn}:${endColumn}]),from=t,limit=${offset}:${offset + limit}).eval()})(${expression})`;
}

/** Paging expressions follow upstream Vector/Table/Matrix views. Never evaluate editor text. */
export async function remotePage(connection: DdbConnection, target: DataTarget, input: BrowseRequest, cache = new Map<string, DdbObj>()): Promise<DataPage> {
  const request = browseRequest(input), { ddb } = connection;
  const node = !['variable', 'variable-schema'].includes(target.kind) && connection.node_type === NodeType.controller ? connection.datanode?.name : undefined;
  const evaluate = (code: string) => ddb.eval(node ? `rpc(${JSON.stringify(node)},parseExpr(${JSON.stringify(code)}))` : code);
  let expression = targetExpression(target);
  const cached = async (path: string) => {
    const key = `${request.revision}:${path}`;
    let obj = cache.get(key);
    if (!obj) { obj = await evaluate(path); cache.clear(); cache.set(key, obj); }
    return obj;
  };
  // Schema dictionaries, charts and tensors are materialized once per browser refresh.
  if (['schema', 'database-schema', 'variable-schema'].includes(target.kind)) { return objectPage(await cached(expression), request); }
  for (let depth = 0; depth < request.path.length; depth++) {
    const form = Number((await evaluate(`form(${expression})`)).value);
    if (form === DdbForm.tensor) { return objectPage(await cached(expression), { ...request, path: request.path.slice(depth) }); }
    const index = request.path[depth];
    if (form === DdbForm.table) {
      const [, rows, columns] = Array.from((await evaluate(metadataQuery(expression))).value as BigInt64Array, Number);
      if (!Number.isSafeInteger(rows) || rows < 0 || index >= columns) { throw new Error('列已不存在，或对象大小超出浏览器可寻址范围。'); }
      if (depth === request.path.length - 1) {
        if (request.offset > rows) { throw new Error('数据范围已变化，请返回首页刷新。'); }
        const table = await evaluate(tableQuery(expression, request.offset, request.limit, index, index + 1));
        const page = objectPage((table.value as DdbVectorObj[])[0], { ...request, path: [], offset: 0, columnOffset: 0 });
        page.count = rows;
        if (page.grid) { page.grid.totalRows = rows; page.grid.rows!.forEach((row, i) => { row[0] = String(request.offset + i); }); }
        page.children?.forEach(child => { child.index += request.offset; child.label = String(child.index); });
        return page;
      }
      // Fetch only the selected row before traversing a nested/array-vector cell.
      const row = request.path[++depth];
      if (row >= rows) { throw new Error('行已不存在，请返回首页刷新。'); }
      expression = `(def(t){v=column(${tableQuery('t', row, 1, index, index + 1)},0);if(type(v)>=64 && type(v)<128){return row(v,0)};return v[0]})(${expression})`;
      continue;
    }
    const type = form === DdbForm.vector ? Number((await evaluate(`type(${expression})`)).value) : 0;
    expression = form === DdbForm.dict ? `values(${expression})[${index}]` : type >= 64 && type < 128 ? `row(${expression},${index})` : `(${expression})[${index}]`;
  }
  const meta = (await evaluate(metadataQuery(expression))).value as BigInt64Array;
  const [form, rows, columns, type] = Array.from(meta, Number);
  if (![rows, columns].every(n => Number.isSafeInteger(n) && n >= 0)) { throw new Error('对象大小超出浏览器可寻址范围。'); }
  if (form === DdbForm.tensor || form === DdbForm.chart) { return objectPage(await cached(expression), { ...request, path: [] }); }
  const { offset, limit, columnOffset } = request;
  const end = Math.min(rows, offset + limit), endColumn = Math.min(columns, columnOffset + request.columnLimit!);
  if (offset > rows || columnOffset > columns && [3, 6].includes(form) || form === DdbForm.table && columns > 0 && columnOffset === columns) { throw new Error('数据范围已变化，请返回首页刷新。'); }
  let code = expression;
  if (form === DdbForm.table && columns > 0) { code = tableQuery(expression, offset, limit, columnOffset, endColumn); }
  else if (form === DdbForm.matrix) { code = `(${expression})[${offset}:${end},${columnOffset}:${endColumn}]`; }
  else if (form === DdbForm.vector && type >= 64 && type < 128) { code = `row(${expression},${offset}:${end})`; }
  else if ([DdbForm.vector, DdbForm.pair].includes(form as any)) { code = `(${expression})[${offset}:${end}]`; }
  else if (form === DdbForm.set) { code = `keys(${expression})[${offset}:${end}]`; }
  // Reconstructing a dictionary on the server rehashes its keys, changing the
  // indexes used by child navigation. Read keys and values in their original order.
  const obj = form === DdbForm.dict ? new DdbObj<DdbDictValue>({ form: DdbForm.dict, type: DdbType.any, rows: end - offset,
    value: [await evaluate(`keys(${expression})[${offset}:${end}]`) as DdbVectorObj, await evaluate(`values(${expression})[${offset}:${end}]`) as DdbVectorObj] }) : await evaluate(code);
  const paged = [1, 2, 3, 4, 5, 6].includes(form);
  const page = objectPage(obj, paged ? { ...request, path: [], offset: 0, columnOffset: 0 } : { ...request, path: [] });
  if (paged) {
    page.count = rows; page.form = ddbFormName(form);
    if ([3, 6].includes(form)) { page.columnCount = columns; }
    if (page.grid) {
      page.grid.totalRows = rows; page.grid.totalColumns = columns ? columns + 1 : page.grid.columns?.length;
      if (page.grid.columns?.[0] === '索引' && (form !== DdbForm.matrix || !(obj.value as DdbMatrixValue).rows)) { page.grid.rows!.forEach((row, i) => { row[0] = String(offset + i); }); }
    }
    page.children?.forEach(child => { child.index += form === DdbForm.table ? columnOffset : offset; });
  }
  return page;
}
