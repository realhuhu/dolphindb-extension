const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { Throttler } = require('@lumino/polling');

const compiled = ts.transpileModule(readFileSync(resolve(__dirname, '../../frontend/session/toolbar.tsx'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

function fixture() {
  const resized = [], errors = [];
  class ReactiveToolbar {
    isDisposed = false;
    isVisible = true;
    // Use the real native limiter, including its asynchronous stop/dispose behavior.
    _resizer = new Throttler(callTwice => { resized.push(callTwice); }, 500);
    onAfterShow() { void this._resizer.stop().then(() => void this._resizer.invoke(true)); }
    fit() {} // An unchanged bounding box does not generate another resize message.
    dispose() { this.isDisposed = true; this._resizer.dispose(); }
  }
  const modules = {
    react: {}, '@jupyterlab/apputils': { ReactWidget: class {} },
    '@jupyterlab/ui-components': { ReactiveToolbar },
    '@lumino/disposable': require('@lumino/disposable'),
    '@lumino/widgets': { Widget: class {} }, '../icons': {},
  };
  const sandbox = { exports: {}, console: { error: (...args) => errors.push(args) }, require: name => {
    assert.ok(modules[name], name); return modules[name];
  } };
  vm.runInNewContext(compiled, sandbox);
  const toolbar = new ReactiveToolbar(), original = toolbar.onAfterShow;
  const guard = sandbox.exports.guardToolbarDisposal(toolbar);
  return { toolbar, original, guard, resized, errors };
}

test('showing a restored toolbar requests native two-pass overflow measurement even at unchanged size', async () => {
  const f = fixture();
  try {
    f.toolbar.onAfterShow(); await settle();
    assert.deepEqual(f.resized, [true]);
    f.toolbar.onAfterShow(); await settle();
    assert.deepEqual(f.resized, [true, true]);
    assert.deepEqual(f.errors, []);
  } finally { f.guard.dispose(); f.toolbar.dispose(); }
});

test('hidden or disposed toolbars cancel delayed show callbacks without invoking a dead limiter', async () => {
  for (const stop of ['hide', 'widget-dispose', 'guard-dispose']) {
    const f = fixture();
    try {
      f.toolbar.onAfterShow();
      if (stop === 'hide') { f.toolbar.isVisible = false; }
      else if (stop === 'widget-dispose') { f.toolbar.dispose(); }
      else { f.guard.dispose(); }
      await settle();
      assert.deepEqual(f.resized, [], stop);
      assert.deepEqual(f.errors, [], stop);
      if (stop === 'hide') {
        f.toolbar.isVisible = true;
        f.toolbar.onAfterShow(); await settle();
        assert.deepEqual(f.resized, [true]);
      }
    } finally { f.guard.dispose(); f.toolbar.dispose(); }
  }
});

test('rapid shows keep only the current callback and cleanup restores the native handler', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 3; i++) { f.toolbar.onAfterShow(); }
    await settle();
    assert.deepEqual(f.resized, [true]);
    assert.deepEqual(f.errors, []);
    f.guard.dispose();
    assert.equal(f.toolbar.onAfterShow, f.original);
  } finally { f.guard.dispose(); f.toolbar.dispose(); }
});
