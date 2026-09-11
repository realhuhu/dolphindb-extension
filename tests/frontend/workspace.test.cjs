const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { Signal } = require('@lumino/signaling');

const variableHelpers = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(resolve(__dirname, '../../frontend/session/variables.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, variableHelpers);
const variable = (name, form, bytes = '24', shared = false) => ({ name, form, bytes, shared, type: 'INT', rows: 4, columns: 2 });

test('variables use upstream location/form ordering, normalize aliases and retain unknown forms', () => {
  const entries = [variable('zTable', 'TABLE', '2048'), variable('aVector', 'VECTOR'), variable('pair', 'PAIR'),
    variable('dict', 'DICT'), variable('object', 'OBJECT'), variable('scalar', 'SCALAR'), variable('new', 'NEW_FORM'),
    variable('sharedTable', 'TABLE', '1024', true), variable('aTable', 'TABLE', '512')];
  const original = entries.slice();
  const groups = variableHelpers.exports.groupVariables(entries);
  assert.deepEqual(Array.from(groups, group => group.label), ['本地变量', '共享变量']);
  assert.deepEqual(Array.from(groups[0].groups, group => group.key), ['SCALAR', 'SYSOBJ', 'PAIR', 'VECTOR', 'DICTIONARY', 'TABLE', 'NEW_FORM']);
  assert.deepEqual(Array.from(groups[0].groups.find(group => group.key === 'TABLE').variables, variable => variable.name), ['aTable', 'zTable']);
  assert.equal(groups[0].bytes, 2704n); assert.equal(groups[1].bytes, 1024n);
  assert.deepEqual(entries, original, 'grouping must not reorder the session metadata used by completion');
  const filtered = variableHelpers.exports.groupVariables(entries, 'ATABLE');
  assert.equal(filtered.length, 1); assert.equal(filtered[0].variables.length, 1);
  assert.equal(filtered[0].groups[0].bytes, 512n);
  assert.equal(variableHelpers.exports.groupVariables(entries, 'missing').length, 0);
});

test('memory totals preserve integer precision and descriptions distinguish counts, shapes and scalars', () => {
  const { formatBytes, totalBytes, variableDescription } = variableHelpers.exports;
  assert.equal(totalBytes([variable('a', 'VECTOR', '9007199254740993'), variable('b', 'VECTOR', '1')]), 9007199254740994n);
  assert.equal(formatBytes('0'), '0 B'); assert.equal(formatBytes('1024'), '1 KiB');
  assert.equal(formatBytes('1536'), '1.5 KiB'); assert.equal(formatBytes('9223372036854775808'), '8 EiB');
  assert.equal(variableDescription(variable('v', 'VECTOR')), '<INT> 4 个元素');
  assert.equal(variableDescription(variable('d', 'DICTIONARY')), '4 个键');
  assert.equal(variableDescription(variable('t', 'TABLE')), '4 行 × 2 列');
  assert.equal(variableDescription({ ...variable('a', 'SCALAR'), value: '42' }), '<INT> = 42');
});

test('hover reads check the live size, quote names and never collect mutable objects in an ANY vector', () => {
  const { variablePreviewScript, VARIABLE_PREVIEW_LIMIT } = variableHelpers.exports;
  assert.equal(VARIABLE_PREVIEW_LIMIT, 10240n);
  const name = 'a");evil();("\\\nend';
  const code = variablePreviewScript(name);
  assert.equal(code.split('\n').length, 3);
  assert.equal(JSON.parse(code.split('\n')[2].slice('objByName('.length, -1)), name);
  assert.match(code, /first\(bytes\).* > 10240/);
  assert.equal(code.includes('line://'), false, 'metadata reads must not be recorded as DOS executions');
});

test('table schema hover quotes references and displays field metadata without internal type IDs', () => {
  const module = { exports: {}, require: id => { assert.equal(id, './interactions'); return interactions(); } };
  vm.runInNewContext(ts.transpileModule(readFileSync(resolve(__dirname, '../../frontend/session/schema.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, module);
  const { tableSchemaScript, schemaDisplayValue } = module.exports;
  const database = 'dfs://a"b', table = 't");evil();("\\\nend';
  assert.equal(tableSchemaScript(database, table), `schema(${interactions().loadTableExpression(database, table)}).colDefs`);
  assert.equal(tableSchemaScript(database, table).includes('line://'), false);
  const schema = schemaDisplayValue({ columns: ['name', 'typeString', 'typeInt', 'extra', 'comment'], totalRows: 2,
    rows: [['id', 'INT', '4', '0', ''], ['price', 'DECIMAL128', '39', '20', '成交价']],
    sortRanks: [[0, 1], [1, 0], [0, 1], [0, 1], [0, 1]] });
  assert.deepEqual(JSON.parse(JSON.stringify(schema)), { columns: ['字段名', '类型', '附加信息', '备注'], totalRows: 2,
    rows: [['id', 'INT', '0', ''], ['price', 'DECIMAL128', '20', '成交价']], sortRanks: [[0, 1], [1, 0], [0, 1], [0, 1]] });
  assert.deepEqual(Array.from(schemaDisplayValue({ columns: ['name', 'typeString', 'extra', 'comment'], rows: [['id', 'INT', '0', '']] }).columns), ['字段名', '类型']);
  assert.throws(() => schemaDisplayValue({ text: 'invalid' }), /表结构/);
});

function interactions() {
  const timers = new Map(); let next = 0;
  const sandbox = { exports: {}, setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(ts.transpileModule(readFileSync(resolve(__dirname, '../../frontend/session/interactions.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  return { ...sandbox.exports, timers, flush: async () => {
    const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn());
    await new Promise(resolve => setImmediate(resolve));
  } };
}

test('rapid sidebar clicks use the last action and pending requests cannot be repeated', async () => {
  const f = interactions(), calls = [], errors = [];
  const actions = new f.DebouncedActions(error => errors.push(error));
  actions.schedule('variable', () => calls.push('first'));
  actions.schedule('variable', () => calls.push('last'));
  await f.flush(); assert.deepEqual(calls, ['last']);
  let finish;
  actions.schedule('table', () => { calls.push('table'); return new Promise(resolve => { finish = resolve; }); });
  await f.flush();
  actions.schedule('table', () => calls.push('duplicate')); await f.flush();
  assert.deepEqual(calls, ['last', 'table']);
  finish(); await f.flush();
  actions.schedule('table', () => calls.push('later')); await f.flush();
  assert.deepEqual(calls, ['last', 'table', 'later']);
  assert.deepEqual(errors, []);
});

test('closing or switching a sidebar cancels delayed actions and reports request errors', async () => {
  const f = interactions(), errors = [];
  let calls = 0;
  const actions = new f.DebouncedActions(error => errors.push(error));
  actions.schedule('variable', () => { calls++; });
  actions.dispose(); await f.flush();
  assert.equal(calls, 0);
  const next = new f.DebouncedActions(error => errors.push(error));
  next.schedule('table', async () => { throw new Error('preview failed'); }); await f.flush();
  assert.equal(errors[0].message, 'preview failed');
  next.schedule('table', () => { calls++; }); await f.flush();
  assert.equal(calls, 1, 'a failed preview must not leave the action permanently blocked');
});

function editorFixture() {
  let source = 'sum()';
  let range = { start: { line: 0, column: 4 }, end: { line: 0, column: 4 } };
  const edits = [];
  const editor = {
    isDisposed: false, readOnly: false, focused: 0,
    model: { sharedModel: { getSource: () => source, updateSource: (from, to, value) => {
      edits.push({ from, to, value }); source = source.slice(0, from) + value + source.slice(to);
    } } },
    getOption: () => editor.readOnly,
    getSelection: () => range, setSelection: value => { range = value; },
    getOffsetAt: position => position.column, getPositionAt: offset => ({ line: 0, column: offset }),
    focus: () => { editor.focused++; },
  };
  return { editor, edits, source: () => source };
}

test('variable insertion uses the original cursor and restores editor focus', () => {
  const { captureVariableInsertion } = interactions(), f = editorFixture();
  let activated = 0;
  const insert = captureVariableInsertion(f.editor, 'prices', () => true, () => { activated++; });
  insert();
  assert.equal(f.source(), 'sum(prices)');
  assert.equal(f.editor.getSelection().start.column, 10);
  assert.equal(f.editor.focused, 1); assert.equal(activated, 1);
  assert.equal(f.edits.length, 1);
  f.editor.setSelection({ start: { line: 0, column: 10 }, end: { line: 0, column: 4 } });
  captureVariableInsertion(f.editor, 'other', () => true)();
  assert.equal(f.source(), 'sum(other)', 'reversed selections must replace only their selected range');
});

test('table insertion quotes database/table names and replaces the captured selection', () => {
  const { loadTableExpression, captureVariableInsertion } = interactions(), f = editorFixture();
  const database = 'dfs://a"b\\c', table = 'a"b\\c\nend';
  const code = loadTableExpression(database, table);
  assert.equal(code, 'loadTable("dfs://a\\"b\\\\c", "a\\"b\\\\c\\nend")');
  captureVariableInsertion(f.editor, code, () => true)();
  assert.equal(f.source(), `sum(${code})`);
  assert.equal(f.editor.focused, 1);
});

test('delayed variable clicks cannot write into a different document, cell, cursor or read-only editor', () => {
  const { captureVariableInsertion } = interactions();
  for (const change of ['document', 'cursor', 'source', 'readonly', 'disposed']) {
    const f = editorFixture(); let current = true;
    const insert = captureVariableInsertion(f.editor, 'prices', () => current);
    if (change === 'document') { current = false; }
    if (change === 'cursor') { f.editor.setSelection({ start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }); }
    if (change === 'source') { f.editor.model.sharedModel.updateSource(0, 0, '// '); }
    if (change === 'readonly') { f.editor.readOnly = true; }
    if (change === 'disposed') { f.editor.isDisposed = true; }
    const before = f.source(); insert();
    assert.equal(f.source(), before, change); assert.equal(f.editor.focused, 0, change);
  }
});

test('sidebar insertion is a separate undo step from adjacent editor typing', async () => {
  const { YFile } = await import('@jupyter/ydoc');
  const shared = new YFile();
  try {
    shared.setSource('sum()'); shared.clearUndoHistory();
    shared.updateSource(0, 3, 'avg');
    const f = editorFixture(); f.editor.model.sharedModel = shared;
    interactions().captureVariableInsertion(f.editor, 'prices', () => true)();
    assert.equal(shared.getSource(), 'avg(prices)');
    shared.updateSource(11, 11, ' + 1');
    shared.undo(); assert.equal(shared.getSource(), 'avg(prices)');
    shared.undo(); assert.equal(shared.getSource(), 'avg()');
    shared.undo(); assert.equal(shared.getSource(), 'sum()');
    shared.redo(); shared.redo(); assert.equal(shared.getSource(), 'avg(prices)');
  } finally { shared.dispose(); }
});

test('the shared workspace follows DOS/notebook focus and removes disposed registrations', () => {
  class Panel {
    title = {};
    binding = null;
    addClass() {}
    setBinding(binding) { this.binding = binding; }
  }
  const modules = {
    '../icons': { dataExplorerIcon: {} },
    '@jupyterlab/application': {}, '@jupyterlab/ui-components': { LabIcon: class {} },
    '@lumino/coreutils': { Token: class {} },
    '@lumino/disposable': { DisposableDelegate: class { constructor(fn) { this.dispose = fn; } } },
    '../dos/views': { WorkspacePanel: Panel },
  };
  const sandbox = { exports: {}, require: id => { assert.ok(modules[id], id); return modules[id]; } };
  vm.runInNewContext(ts.transpileModule(readFileSync(resolve(__dirname, '../../frontend/session/workspace.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  const shell = { currentWidget: null, currentChanged: new Signal({}), add() {}, activateById() {} };
  const workspace = new sandbox.exports.SessionWorkspace({ shell, restored: Promise.resolve() });
  const dos = {}, notebook = {}, other = {};
  const dosBinding = { model: {}, path: () => 'a.dos', scope: 'file' };
  const changes = [];
  const notebookBinding = { model: { setPanelActive: value => changes.push(value) }, path: () => 'b.ipynb', scope: 'kernel' };
  const dosRegistration = workspace.register(dos, dosBinding);
  const notebookRegistration = workspace.register(notebook, notebookBinding);
  shell.currentWidget = dos; shell.currentChanged.emit();
  assert.equal(workspace.panel.binding, dosBinding);
  shell.currentWidget = notebook; shell.currentChanged.emit();
  assert.equal(workspace.panel.binding, notebookBinding);
  assert.deepEqual(changes, [true]);
  dosRegistration.dispose();
  assert.equal(workspace.panel.binding, notebookBinding, 'closing a DOS file must not clear the current notebook');
  shell.currentWidget = other; shell.currentChanged.emit();
  assert.equal(workspace.panel.binding, null);
  assert.deepEqual(changes, [true, false]);
  shell.currentWidget = notebook; shell.currentChanged.emit();
  notebookRegistration.dispose();
  assert.equal(workspace.panel.binding, null);
  assert.deepEqual(changes, [true, false, true, false]);
});
