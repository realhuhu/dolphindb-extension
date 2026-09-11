const assert = require('node:assert/strict');
const test = require('node:test');
const { dataLoader } = require('./load-data.cjs');
let sdk, load, browse;
test.before(async () => { sdk = await import('dolphindb/browser.js'); load = dataLoader(sdk); browse = load('data/sdk'); });
const query = changes => ({ path: [], offset: 0, limit: 100, columnOffset: 0, ...changes });
const plain = value => JSON.parse(JSON.stringify(value));
const vector = (values, name = 'v', type) => new sdk.DdbObj({ form: sdk.DdbForm.vector, type: type ?? sdk.DdbType.int, value: values, rows: values.length, name, le: true });

test('custom row/column defaults travel with MIME tickets and cache limits keep the newest result', async () => {
  const own = dataLoader(sdk), preferences = require('./preferences.cjs').preferences();
  preferences.value.dataBrowser = { pageSize: 13, columnPageSize: 2 };
  preferences.value.advanced.cacheEntries = 1;
  own('data/preferences').bindDisplaySettings(preferences);
  const registry = own('data/registry');
  const table = new sdk.DdbObj({ form: sdk.DdbForm.table, type: sdk.DdbType.void, rows: 60, cols: 6,
    value: Array.from({ length: 6 }, (_, c) => vector(Int32Array.from({ length: 60 }, (_, r) => c * 100 + r), `c${c}`)) });
  const first = registry.snapshotTicket(table), second = registry.snapshotTicket(table);
  assert.equal(second.initial.grid.rows.length, 13);
  assert.equal(second.initial.grid.columns.length, 3);
  assert.equal(second.initialRequest.columnLimit, 2);
  assert.ok(own('data/types').dataTicket(second));
  await assert.rejects(registry.readSnapshot(first.target.id, query()), /已释放/);
  const page = await registry.readSnapshot(second.target.id, { ...second.initialRequest, offset: 13, columnOffset: 2 });
  assert.deepEqual(plain(page.grid.rows[0]), ['13', '213', '313']);
  assert.deepEqual(plain(page.children.map(child => child.index)), [2, 3]);
  for (const columnLimit of [0, -1, 201, 1.2, '2']) { assert.throws(() => browse.objectPage(table, query({ columnLimit }))); }
});

test('data browser pages rows and columns without truncating the underlying result', () => {
  const columns = Array.from({ length: 63 }, (_, col) => vector(Int32Array.from({ length: 240 }, (_, row) => col * 1000 + row), `col${col}`));
  const table = new sdk.DdbObj({ form: sdk.DdbForm.table, type: sdk.DdbType.void, rows: 240, cols: 63, value: columns });
  const page = browse.objectPage(table, query({ offset: 200, columnOffset: 50 }));
  assert.equal(page.count, 240); assert.equal(page.columnCount, 63); assert.equal(page.grid.rows.length, 40);
  assert.deepEqual(plain(page.grid.rows[0].slice(0, 3)), ['200', '50200', '51200']);
  assert.equal(page.children[0].index, 50);
  const child = browse.objectPage(table, query({ path: [50], offset: 200 }));
  assert.equal(child.grid.rows[0][1], '50200');
});

test('nested dictionaries and ANY vectors navigate by the original object index', () => {
  const values = vector([vector(Int32Array.of(11, 12)), vector(Int32Array.of(21, 22))], 'values', sdk.DdbType.any);
  const dictionary = new sdk.DdbObj({ form: sdk.DdbForm.dict, type: sdk.DdbType.any, rows: 2,
    value: [vector(['second', 'first'], 'keys', sdk.DdbType.string), values] });
  const root = browse.objectPage(dictionary, query());
  assert.equal(root.children[0].label, 'second');
  const child = browse.objectPage(dictionary, query({ path: [0] }));
  assert.equal(child.grid.rows[0][1], '11');
  assert.equal(browse.objectPage(dictionary, query({ path: [0, 1] })).text, '12');
  assert.throws(() => browse.objectPage(dictionary, query({ path: [4] })), /不存在/);
});

test('matrix pages retain column-major indexing and row/column labels', () => {
  const matrix = new sdk.DdbObj({ form: sdk.DdbForm.matrix, type: sdk.DdbType.long, rows: 3, cols: 2, le: true,
    value: { data: BigInt64Array.of(9007199254740993n, 2n, 3n, 4n, 5n, 6n), rows: vector(['a','b','c'], '', sdk.DdbType.string), cols: vector(['x','y'], '', sdk.DdbType.string) } });
  const page = browse.objectPage(matrix, query({ offset: 1, limit: 1 }));
  assert.deepEqual(plain(page.grid.rows), [['b','2','5']]);
  assert.equal(browse.objectPage(matrix, query()).grid.rows[0][1], '9007199254740993');
});

test('tensor navigation respects every stride, endian flag and INT64 precision', () => {
  for (const le of [true, false]) {
    const bytes = new Uint8Array(12 * 8), view = new DataView(bytes.buffer);
    for (let i=0;i<12;i++) { view.setBigInt64(i * 8, 9007199254740993n + BigInt(i), le); }
    const tensor = new sdk.DdbObj({ form: sdk.DdbForm.tensor, type: sdk.DdbType.long, le,
      value: { dimensions: 2, shape: [2,3], strides: [6,2], data_type: sdk.DdbType.long, data: bytes } });
    const root = browse.objectPage(tensor, query());
    assert.equal(root.form, 'TENSOR'); assert.equal(root.children.length, 2);
    const leaf = browse.objectPage(tensor, query({ path: [1], offset: 1 }));
    assert.deepEqual(plain(leaf.grid.rows), [['1', '9007199254741001'], ['2', '9007199254741003']]);
  }
});

test('display precision rounds decimal strings without changing integer or Decimal128 precision', () => {
  const { formatNumeric, formatCell } = load('data/format');
  assert.equal(formatNumeric('9007199254740993.1234567890123456789', 18), '9007199254740993.123456789012345679');
  assert.equal(formatNumeric('-1.005', 2), '-1.01');
  assert.equal(formatNumeric('1.2e-5', 8), '0.00001200');
  assert.equal(formatNumeric('1.25', null), '1.25');
  assert.equal(formatNumeric('null', 3), 'null');
  assert.equal(formatNumeric('-0.001', 2), '0.00');
  assert.equal(formatCell('[1.005, -2.999, null, ...]', 'DOUBLE[]', 2), '[1.01, -3.00, null, ...]');
  assert.equal(formatCell('9007199254740993', 'LONG', 2), '9007199254740993');
});

test('chart conversion retains series, multi-axis data, zero-volume candles and constant histogram bins', () => {
  const { chartConfig } = load('data/chart');
  const { get_chart_option } = load('upstream/charts');
  const chart = { type: sdk.DdbChartType.kline, titles: { chart:'Price',x_axis:'Date',y_axis:'Price' }, stacking:false,multiY:false,
    rowLabels:['2026.09.01'],columnLabels:['open','high','low','close','vol'],values:[[2,4,1,3,0]] };
  assert.deepEqual(plain(get_chart_option(chartConfig(chart)).series[0].data), [[2,3,1,4]]);
  assert.equal(get_chart_option(chartConfig(chart)).series.length, 2);
  const histogram = { ...chart, type:sdk.DdbChartType.histogram,columnLabels:['v'], rowLabels:[0,1,2], values:[[5],[5],[5]] };
  const options = get_chart_option(chartConfig(histogram));
  assert.equal(options.series[0].data.reduce((a,b)=>a+b,0),3);
});

test('table statement generation follows partition columns and only produces source text', () => {
  const { tableStatement } = load('session/table-actions');
  const definition = { columns:['date','symbol','price'],partitionColumns:['date','symbol'] };
  assert.equal(tableStatement('select','dfs://x','prices',definition),'select * from loadTable("dfs://x", "prices") where date= and symbol=');
  assert.equal(tableStatement('update','dfs://x','prices',definition,'cat.db'),'update cat.db.prices set date=, symbol=, price= where date= and symbol=');
  assert.equal(tableStatement('truncate','dfs://x','prices'),'truncate("dfs://x", "prices")');
  assert.equal(tableStatement('schema','dfs://x','prices'),'schema(loadTable("dfs://x", "prices"))');
  assert.equal(tableStatement('load','dfs://a"b','c\\d'),'loadTable("dfs://a\\"b", "c\\\\d")');
});

test('browsing rejects code in indexes, unbounded page sizes and fractional offsets', () => {
  const { browseRequest } = load('data/types');
  for (const input of [{path:['0);dropDatabase()']},{limit:1001},{limit:0},{offset:0.5},{columnOffset:-1},{revision:Infinity}]) {
    assert.throws(()=>browseRequest(query(input)),/无效/);
  }
  assert.equal(browse.targetExpression({ kind:'variable',name:'x");evil();("' }), 'objByName("x\\");evil();(\\"")');
});

test('array-vector drill keeps block boundaries, decimal scales and INT64 precision', () => {
  const values = [{ rows: 2, unit: 1, lengths: Uint8Array.of(2, 1), data: BigInt64Array.of(9007199254740993n, 2n, 3n) },
    { rows: 1, unit: 1, lengths: Uint8Array.of(2), data: BigInt64Array.of(4n, 5n) }];
  const array = new sdk.DdbObj({ form: sdk.DdbForm.vector, type: 64 + sdk.DdbType.long, le: true, rows: 3, value: values });
  assert.equal(browse.objectPage(array, query()).children.length, 3);
  assert.deepEqual(plain(browse.objectPage(array, query({path:[2]})).grid.rows), [['0','4'],['1','5']]);
  assert.equal(browse.objectPage(array, query({path:[0]})).grid.rows[0][1], '9007199254740993');
  values.scale = 2; array.type = 64 + sdk.DdbType.decimal64;
  assert.equal(browse.objectPage(array, query({path:[0]})).grid.rows[0][1], '90071992547409.93');
});

test('remote array vectors select rows rather than the SDK bracket operator columns', async () => {
  const calls = [], ddb = {eval: async code => {
    calls.push(code);
    if (code.startsWith('form(')) { return {value:1}; }
    if (code.startsWith('type(')) { return {value:68}; }
    if (code.startsWith('(def(x)')) { return vector(BigInt64Array.of(1n,152n,0n,4n), '', sdk.DdbType.long); }
    assert.equal(code,'(row(objByName("a"),1))[100:152]');
    return vector(Int32Array.from({length:52},(_,i)=>251+i));
  }};
  const page = await browse.remotePage({ddb},{kind:'variable',name:'a'},query({path:[1],offset:100}));
  assert.deepEqual(plain(page.grid.rows[0]),['100','251']); assert.equal(page.count,152);
  assert.equal(calls.length,4);
});

test('live SQL paging preserves DFS counts, column navigation and nested array cells', {
  skip: !process.env.DDB_TEST_HOST && 'Set DDB_TEST_HOST/USER/PASSWORD to run the live SDK regression',
}, async () => {
  const ddb = new sdk.DDB(`ws://${process.env.DDB_TEST_HOST}:${process.env.DDB_TEST_PORT ?? 8848}`, {
    autologin: true, username: process.env.DDB_TEST_USER, password: process.env.DDB_TEST_PASSWORD, verbose: false,
  });
  ddb.print_message = false;
  const database = `dfs://ddb_extension_browser_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const literal = JSON.stringify(database);
  let owned = false;
  try {
    await ddb.connect();
    assert.equal((await ddb.eval(`existsDatabase(${literal})`)).value, false);
    await ddb.eval(`browserTestDb=database(${literal}, VALUE, 0..2)`);
    owned = true;
    await ddb.eval('browserTestData=table(take(0,257) as part,0..256 as id,(0..256)+1000 as price);'
      + 'browserTestDb.createPartitionedTable(browserTestData,`prices,`part).append!(browserTestData);'
      + 'browserTestDb.createPartitionedTable(browserTestData,`empty,`part)');
    await ddb.eval(`browserTestDfs=loadTable(${literal},\`prices)`);
    assert.equal(Number((await ddb.eval('size(browserTestDfs)')).value), 0);
    const read = (target, changes) => browse.remotePage({ ddb }, target, query(changes));
    for (const target of [{ kind: 'variable', name: 'browserTestData' }, { kind: 'variable', name: 'browserTestDfs' },
      { kind: 'table', database, table: 'prices' }]) {
      const page = await read(target, { offset: 200, columnOffset: 1, columnLimit: 1 });
      assert.equal(page.count, 257); assert.equal(page.columnCount, 3);
      assert.deepEqual(plain(page.grid.columns), ['索引', 'id']);
      assert.deepEqual(plain(page.grid.rows), Array.from({ length: 57 }, (_, i) => [String(i + 200), String(i + 200)]));
      assert.equal(page.children[0].index, 1);
      const column = await read(target, { path: [2], offset: 200 });
      assert.equal(column.form, 'VECTOR'); assert.equal(column.count, 257);
      assert.deepEqual(plain(column.grid.rows), Array.from({ length: 57 }, (_, i) => [String(i + 200), String(i + 1200)]));
      assert.equal((await read(target, { path: [2, 201] })).text, '1201');
      assert.deepEqual(plain((await read(target, { offset: 257 })).grid.rows), []);
      await assert.rejects(read(target, { path: [3] }), /列已不存在/);
      await assert.rejects(read(target, { path: [2, 257] }), /行已不存在/);
    }
    for (const path of [[], [2]]) {
      const page = await read({ kind: 'table', database, table: 'empty' }, { path });
      assert.equal(page.count, 0); assert.deepEqual(plain(page.grid.rows), []);
    }
    await ddb.eval('browserTestVectors=array(INT[],0,3);append!(browserTestVectors,[1 2,3 4 5,6 7]);'
      + 'browserTestArrays=table(1..3 as id,browserTestVectors as vals)');
    const target = { kind: 'variable', name: 'browserTestArrays' };
    const page = await read(target, { path: [1], offset: 1, limit: 1 });
    assert.equal(page.children[0].index, 1); assert.equal(page.children[0].label, '1');
    assert.deepEqual(plain((await read(target, { path: [1, 1] })).grid.rows), [['0', '3'], ['1', '4'], ['2', '5']]);
    assert.equal((await read(target, { path: [1, 1, 1] })).text, '4');
  } finally {
    try { if (owned) { await ddb.eval(`dropDatabase(${literal})`); } }
    finally { ddb.disconnect(); }
  }
});

test('saved MIME tickets validate all grid/chart/child shapes before rendering', () => {
  const { dataTicket } = load('data/types');
  const ticket = { owner: 'kernel', title: 'Data', target: {kind:'result',id:'1'}, initial: browse.objectPage(vector(Int32Array.of(1,2)), query()) };
  assert.equal(dataTicket(ticket), ticket);
  for (const change of [{grid:{columns:['x'],rows:[[{bad:true}]]}}, {children:[{index:-1,label:'x',description:'y'}]},
    {chart:{type:4}}, {count:-1}, {shape:[Infinity]}]) {
    assert.equal(dataTicket({...ticket,initial:{...ticket.initial,...change}}), null);
  }
});
