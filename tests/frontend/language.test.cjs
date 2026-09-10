const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const cache = new Map();
function load(path) {
  path = resolve(__dirname, '../../frontend', path);
  if (!existsSync(path)) { path += '.ts'; }
  if (cache.has(path)) { return cache.get(path); }
  const exports = {}; cache.set(path, exports);
  const requireModule = createRequire(path);
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { exports, console, setTimeout, clearTimeout, require: id => id.startsWith('.') ? load(resolve(dirname(path), id)) : requireModule(id) }, { filename: path });
  return exports;
}
const { ddbRegions, projection, projectDdb, tableReference } = load('language/regions.ts');
const { LanguageEngine, documentation } = load('language/engine.ts');
const { ModuleIndex } = load('language/modules.ts');
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(files = {}, name = 'ownedTable') {
  const calls = [];
  const contents = { get: async (path, options) => path in files ? { type: 'file', content: options?.content ? files[path] : null }
    : { type: 'directory', content: Object.keys(files).map(path => ({ path, name: path.split('/').at(-1), type: 'file' })) } };
  const modules = new ModuleIndex(contents);
  const engine = new LanguageEngine(modules, () => ({ moduleRoot: '', documentationLanguage: 'zh' }));
  const binding = { path: () => 'current.dos', source: () => '', project: (text, offset) => projection(text, offset, true), identity: () => name,
    open: async () => {}, metadata: async (operation, args) => {
      calls.push([operation, plain(args)]);
      if (operation === 'snapshot') { return { variables: [{ name, form: 'TABLE', type: 'ANY' }], sharedTables: [name], databases: ['dfs://market'], catalogs: ['catalogA'] }; }
      if (operation === 'columns') { return ['symbol', 'price']; }
      if (operation === 'tables') { return ['ticks']; }
      if (operation === 'schemas') { return ['schemaA']; }
      if (operation === 'schemaTables') { return ['tableA']; }
      return [];
    } };
  return { engine, binding, modules, calls, complete: async (text, offset = text.length) => engine.complete(binding, projection(text, offset, true)) };
}

test('magic projection preserves offsets and excludes Python strings/comments and output targets', () => {
  const text = 'python = 5\naaa=%ddb sum(1..3)\n# %ddb comment\n"""\n%ddb in_string\n"""\n%ddb table(1 as id)';
  const regions = ddbRegions(text);
  assert.deepEqual(plain(regions.map(r => text.slice(r.from, r.to))), ['sum(1..3)', 'table(1 as id)']);
  assert.equal(projectDdb(text).length, text.length);
  assert.equal(projection(text, 3), null);
  const block = '%%ddb -o result\nt = table(1 as id)\nt';
  assert.equal(projectDdb(block).split('\n')[0].trim(), '');
  assert.equal(projection(block, block.length, false, [text]).base, text.length + 1);
});

test('only inert table references can request runtime column metadata', () => {
  assert.deepEqual(plain(tableReference('myTable')), { kind: 'variable', name: 'myTable' });
  assert.deepEqual(plain(tableReference('cat.schema.table')), { kind: 'catalog', catalog: 'cat', schema: 'schema', table: 'table' });
  assert.deepEqual(plain(tableReference('loadTable("dfs://market", `ticks)')), { kind: 'dfs', database: 'dfs://market', table: 'ticks' });
  for (const text of ['delete from t', 'run("dropDatabase()")', 't);dropDatabase("dfs://x");(', 'loadTable(foo(), "x")']) { assert.equal(tableReference(text), null); }
});

test('builtin fuzzy completion and signature help use the original DocsProvider', async () => {
  const f = fixture();
  const items = (await f.complete('loadT')).items;
  assert.ok(items.some(item => item.label === 'loadTable'));
  const docs = await documentation();
  const help = docs.get_signature_help('loadTable("dfs://market", ');
  assert.equal(help.signature.name, 'loadTable');
  assert.equal(help.active_parameter, 1);
  assert.ok(docs.get_function_markdown('loadTable').length > 1600);
});

test('scope-aware parameters, local definitions, docs and snippets come from upstream', async () => {
  const f = fixture();
  const text = '// @Brief: Adds one\ndef increment(value) {\n    localValue = value + 1\n    loc\n}\nincrement(1)';
  const inside = (await f.complete(text, text.indexOf('    loc\n') + 7)).items;
  assert.ok(inside.some(item => item.label === 'value'));
  assert.ok(inside.some(item => item.label === 'localValue'));
  const outside = (await f.complete(text)).items;
  assert.ok(!outside.some(item => item.label === 'localValue'));
  assert.ok(outside.some(item => item.label === 'def' && item.insertText.includes('${1:functionName}')));
  assert.ok(outside.some(item => item.label === 'increment' && item.insertText.includes('${0}')));
  const position = text.lastIndexOf('increment') + 3;
  const projected = projection(text, position, true);
  const locations = await f.engine.definitions(f.binding, projected);
  assert.equal(locations[0].range.start.line, 1);
  const hover = await f.engine.hover(f.binding, projected);
  assert.ok(hover.contents.value.includes('Adds one'));
});

test('module completion imports, qualified calls, definitions, and diagnostics are retained', async () => {
  const f = fixture({ 'analytics.dos': 'module analytics\n// @Brief: module function\ndef moduleFunction(input) {\n return input\n}\n' });
  const completion = (await f.complete('moduleF')).items.find(item => item.label === 'moduleFunction');
  assert.equal(completion.insertText, 'analytics::moduleFunction(${1:input})');
  assert.equal(completion.additionalTextEdits[0].newText, 'use analytics\n');
  const source = 'use analytics\nanalytics::moduleFunction(1)';
  const locations = await f.engine.definitions(f.binding, projection(source, source.indexOf('moduleFunction') + 2, true));
  assert.equal(locations[0].uri, 'analytics.dos');
  const moduleImport = await f.engine.definitions(f.binding, projection(source, 7, true));
  assert.equal(moduleImport[0].uri, 'analytics.dos');
  const diagnostics = await f.engine.diagnostics(f.binding, projection('use missing\n', 5, true));
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /missing/);
});

test('SQL contexts cover catalogs, schemas, tables, fields, order-by and loadTable arguments', async () => {
  const f = fixture();
  const cases = [
    ['select * from ', 'ownedTable'], ['select * from catalogA.', 'schemaA'],
    ['select * from catalogA.schemaA.', 'tableA'], ['select * from ownedTable where ', 'price'],
    ['select * from ownedTable order by ', 'nulls last'], ['insert into ', 'ownedTable'],
    ['loadTable(', '"dfs://market"'], ['loadTable("dfs://market", ', '"ticks"'], ['ownedTable.', 'symbol'],
  ];
  for (const [source, expected] of cases) { assert.ok((await f.complete(source)).items.some(item => item.label === expected), source + ' -> ' + expected); }
  await f.complete('select * from run("evil()") where ');
  assert.ok(!f.calls.some(([operation, args]) => operation === 'columns' && JSON.stringify(args).includes('evil')));
});

test('a dot after an unexecuted table never falls back to the entire builtin catalog', async () => {
  const f = fixture();
  f.binding.metadata = async () => { throw new Error('No execution session yet'); };
  const source = 'sessionLabel = "file A"\ncounter = 1\nsamples = 1 2 3\nprices = table(1..3 as id, 10.5 11.2 12.3 as price)\nprices.';
  const result = await f.complete(source);
  assert.equal(result.items.length, 5);
  assert.deepEqual(plain(result.items.map(item => item.label).sort()), ['counter', 'def', 'prices', 'samples', 'sessionLabel']);
  assert.equal(result.from, source.length);
  assert.equal(result.to, source.length);
});

test('table member completion contains only that table columns in DOS and both magics', async () => {
  const f = fixture({ 'analytics.dos': 'module analytics\ndef unrelatedFunction(x) { return x }' }, 'prices');
  const columns = ['id', 'symbol', 'date', 'open', 'high', 'low', 'close', 'volume', 'price'];
  const metadata = f.binding.metadata;
  f.binding.metadata = async (operation, args) => operation === 'columns' ? columns : metadata(operation, args);
  for (const [source, file] of [['counter = 1\nprices.', true], ['%%ddb\ncounter = 1\nprices.', false], ['aaa=%ddb prices.pr', false]]) {
    const result = await f.engine.complete(f.binding, projection(source, source.length, file));
    assert.equal(result.items.length, columns.length);
    assert.deepEqual(plain(result.items.map(item => item.label)), columns);
    assert.equal(source.slice(result.from, result.to), source.endsWith('pr') ? 'pr' : '');
  }
});

test('qualified SQL sources retain upstream priority instead of mixing in member columns', async () => {
  const f = fixture();
  const result = await f.complete('select * from catalogA.');
  assert.deepEqual(plain(result.items.map(item => item.label)), ['schemaA']);
  assert.ok(!f.calls.some(([operation]) => operation === 'columns'));
});

test('simultaneous document completions never mix session metadata or source symbols', async () => {
  const a = fixture({}, 'sessionA'), b = fixture({}, 'sessionB');
  const [first, second] = await Promise.all([a.complete('aVar = 1\n'), b.complete('bVar = 2\n')]);
  assert.ok(first.items.some(v => v.label === 'sessionA'));
  assert.ok(!first.items.some(v => ['sessionB', 'bVar'].includes(v.label)));
  assert.ok(second.items.some(v => v.label === 'sessionB'));
  assert.ok(!second.items.some(v => ['sessionA', 'aVar'].includes(v.label)));
});

test('path and table name completion replaces a literal prefix without duplicating quotes', async () => {
  const f = fixture();
  for (const [source, expected] of [['loadTable("dfs://ma', 'dfs://market'], ['loadTable("dfs://market", `ti', 'ticks']]) {
    const result = await f.complete(source);
    const item = result.items.find(item => item.label === expected);
    assert.ok(item, source);
    assert.equal(item.insertText, expected);
    assert.equal(source.slice(result.from), source.endsWith('ma') ? 'dfs://ma' : 'ti');
  }
  const closed = 'loadTable("dfs://market", `ticks)';
  const result = await f.complete(closed, closed.indexOf('market') + 2);
  assert.equal(closed.slice(result.from, result.to), 'dfs://market');
  assert.equal(closed[result.to], '"');
  const middle = await f.complete('loadTale(1)', 5);
  assert.equal('loadTale(1)'.slice(middle.from, middle.to), 'loadTale');
});

test('notebook analysis includes preceding DDB cells with the original cursor offset', async () => {
  const f = fixture();
  const current = 'aaa=%ddb earlierFunction(2)';
  const projected = projection(current, current.indexOf('earlierFunction') + 3, false, ['%%ddb\ndef earlierFunction(x) {\n return x\n}']);
  const locations = await f.engine.definitions(f.binding, projected);
  assert.equal(locations[0].range.start.line, 1);
});
