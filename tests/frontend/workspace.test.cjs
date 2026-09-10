const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { Signal } = require('@lumino/signaling');

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
    '@jupyterlab/application': {}, '@jupyterlab/ui-components': { LabIcon: class {} },
    '@lumino/coreutils': { Token: class {} },
    '@lumino/disposable': { DisposableDelegate: class { constructor(fn) { this.dispose = fn; } } },
    '../dos/views': { WorkspacePanel: Panel },
  };
  const sandbox = { exports: {}, require: id => { assert.ok(modules[id], id); return modules[id]; } };
  vm.runInNewContext(ts.transpileModule(readFileSync(resolve(__dirname, '../../frontend/session/workspace.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  const shell = { currentWidget: null, currentChanged: new Signal({}), add() {}, activateById() {} };
  const workspace = new sandbox.exports.SessionWorkspace({ shell });
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
