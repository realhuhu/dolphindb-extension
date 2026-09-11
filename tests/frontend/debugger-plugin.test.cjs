const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { Signal } = require('@lumino/signaling');
const { dataLoader } = require('./load-data.cjs');

const ids = Object.fromEntries(Object.entries({ start: 'start', resume: 'continue', stop: 'stop', next: 'next',
  stepIn: 'step-in', stepOut: 'step-out', restart: 'restart', toggle: 'breakpoint', show: 'show' })
  .map(([key, value]) => [key, 'dolphindb-extension:debug-' + value]));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pluginFile = path.resolve(__dirname, '../../frontend/debugger/plugin.ts');
const pluginCode = ts.transpileModule(fs.readFileSync(pluginFile, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

/** Run the real plugin and session against a fake transport and minimal Jupyter widgets. */
async function fixture(paths, saved = {}) {
  const sdk = await import('dolphindb/browser.js'), { DosDebugSession } = dataLoader(sdk)('debugger/session');
  const instances = [], handlers = [], starts = [], opened = [], errors = [];
  const configuration = { modules: {}, source: async () => 'old module' };
  const commands = new Map(), models = new Map();
  let panel;
  class Session {
    constructor(file, host) {
      const session = new DosDebugSession(file, host, url => {
        let source;
        return { connect: async () => {}, close() {}, call: async (func, args) => {
          if (func === 'parseScriptWithDebug') { source = args[0]; return { modules: configuration.modules }; }
          if (func === 'setBreaks') { return [args[0], args[1]]; }
          if (func === 'runScriptWithDebug') { starts.push({ path: file, connection: url, source }); }
          if (func === 'sourceRequest') { return configuration.source(args); }
        } };
      });
      instances.push(session); return session;
    }
  }
  class Panel {
    constructor(options) { this.options = options; this.id = 'test-debug-panel'; panel = this; }
    setSession(session) { this.session = session; }
    refresh() {}
  }
  class Editor {
    constructor(source) { this.source = source; this.options = { readOnly: false }; }
    get lineCount() { return this.source.split('\n').length; }
    getOption(key) { return this.options[key]; }
    setOption(key, value) { this.options[key] = value; }
    setCursorPosition() {}
    revealPosition() {}
  }
  class DebugEditor {
    constructor(editor, session) { this.editor = editor; this.session = session; handlers.push(this); }
    dispose() { this.disposed = true; }
    reveal() {}
    toggle() {}
  }
  class Widget {
    constructor(content) { this.content = content; this.title = {}; this.isDisposed = false; this.disposed = new Signal(this); }
    dispose() { if (!this.isDisposed) { this.isDisposed = true; this.disposed.emit(); } }
  }
  class MainWidget extends Widget { constructor({ content }) { super(content); } }
  const content = source => {
    const editor = new Editor(source);
    return { editor, model: { sharedModel: { getSource: () => editor.source, setSource: value => { editor.source = value; } } },
      node: { addEventListener() {}, removeEventListener() {} } };
  };
  class Factory { createNewEditor({ content: source }) { return content(source); } }
  const widgets = paths.map((file, index) => {
    if (!models.has(file)) {
      const model = { path: file, profile: { id: file, name: file }, useDefault: async () => {} };
      model.changed = new Signal(model); models.set(file, model);
    }
    const widget = new Widget(content('program from ' + file)); widget.id = 'view-' + index;
    widget.context = { path: file, ready: Promise.resolve() }; widget.context.pathChanged = new Signal(widget.context);
    return widget;
  });
  const shell = { currentWidget: widgets[0], add(widget, area) { if (area === 'main') { opened.push(widget); } },
    activateById(id) {
      const widget = [...widgets, ...opened].find(view => view.id === id);
      if (widget && this.currentWidget !== widget) { this.currentWidget = widget; this.currentChanged.emit(); }
    } };
  shell.currentChanged = new Signal(shell);
  const app = { shell, contextMenu: { addItem() {} }, commands: { addCommand: (id, command) => commands.set(id, command),
    hasCommand: id => commands.has(id), notifyCommandChanged() {}, addKeyBinding() {} } };
  const mocks = {
    '@jupyterlab/apputils': { MainAreaWidget: MainWidget, showErrorMessage: (_title, error) => { errors.push(error); } },
    '@jupyterlab/debugger': { Debugger: { ReadOnlyEditorFactory: Factory, Icons: {} } },
    '@lumino/signaling': { Signal }, './panel': { DebugPanel: Panel, debugCommands: ids },
    './editor': { DebugEditor }, './session': { DosDebugSession: Session }, '../dos/language': { DOS_MIME: 'text/x-dolphindb' },
    '../api': { socketUrl: path => path, request: async (_url, _method, body) => ({ path: body.id, username: '', password: '', timeout: 2 }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(pluginCode, { module, exports: module.exports, require: id => mocks[id] ?? {},
    setTimeout, clearTimeout, crypto: globalThis.crypto, console }, { filename: pluginFile });
  const editors = { widgetAdded: new Signal({}), currentChanged: new Signal({}), forEach: callback => widgets.forEach(callback) };
  module.exports.default.activate(app, { document: file => models.get(file) }, editors, {}, {}, {}, null, null, shell, null, null,
    { fetch: async () => saved, save: async () => {} });
  await tick(); assert.deepEqual(errors, []);
  return { instances, handlers, starts, opened, errors, configuration, models, widgets, panel, commands, shell,
    activate: index => shell.activateById(widgets[index].id),
    close: async () => { await Promise.all(instances.map(session => session.stop())); } };
}

test('sidebar starts the selected DOS and connection; editor commands retain the active file target', async t => {
  const f = await fixture(['a.dos', 'b.dos', 'notes.ipynb']); t.after(f.close);
  const command = f.commands.get(ids.start);
  f.panel.options.select(f.instances[1]);
  assert.equal(f.shell.currentWidget, f.widgets[0]);
  await command.execute({ fromSidebar: true });
  assert.deepEqual(f.starts[0], { path: 'b.dos', connection: 'b.dos', source: 'program from b.dos' });
  assert.equal(f.shell.currentWidget, f.widgets[1]);
  await f.instances[1].stop();
  f.activate(0); f.panel.options.select(f.instances[1]);
  await command.execute({});
  assert.equal(f.starts[1].path, 'a.dos');
  f.activate(2); assert.equal(command.isEnabled({}), false);
  await command.execute({}); assert.equal(f.starts.length, 2);
});

test('restoring multiple views with saved breakpoints shares one session until the last view closes', async t => {
  const f = await fixture(['same.dos', 'same.dos'], { 'same.dos': { lines: [1], exceptions: true } }); t.after(f.close);
  assert.equal(f.instances.length, 1); assert.equal(f.panel.options.sessions().length, 1);
  assert.equal(f.handlers[0].session, f.handlers[1].session);
  assert.equal(f.instances[0].exceptions, true);
  const command = f.commands.get(ids.start);
  for (let index = 0; index < 2; index++) { f.activate(index); assert.equal(command.isEnabled({}), true); }
  await command.execute({}); assert.equal(f.shell.currentWidget, f.widgets[1]);
  assert(f.widgets.every(widget => widget.content.editor.getOption('readOnly')));
  f.widgets[0].dispose(); await tick(); assert.equal(f.instances[0].active, true);
  f.widgets[1].dispose(); await tick(); assert.equal(f.instances[0].active, false);
});

test('a new debug run invalidates imported source windows and keeps module breakpoints', async t => {
  const f = await fixture(['entry.dos']); t.after(f.close);
  f.configuration.modules = { 'qa::math': '/server/qa/math.dos' };
  await f.commands.get(ids.start).execute({});
  const session = f.instances[0], sourcePath = session.sourcePath('qa::math');
  await session.setBreakpoints(sourcePath, [1]);
  await f.panel.options.open(session, sourcePath);
  const previous = f.opened[0], previousHandler = f.handlers.at(-1);
  assert.equal(previous.content.model.sharedModel.getSource(), 'old module');
  await session.stop(); f.activate(0);
  f.configuration.source = async () => 'module from replacement connection';
  f.models.get('entry.dos').profile = { id: 'replacement', name: 'Replacement' };
  await f.commands.get(ids.start).execute({});
  assert.equal(previous.isDisposed, true); assert.equal(previousHandler.disposed, true);
  assert.equal(session.breaks.get(sourcePath)[0].line, 1);
  await f.panel.options.open(session, sourcePath);
  assert.equal(f.opened.at(-1).content.model.sharedModel.getSource(), 'module from replacement connection');
  assert.equal(f.opened.filter(widget => !widget.isDisposed).length, 1);
});

test('a delayed module source reply cannot open a window for a replaced debug run', async t => {
  const f = await fixture(['entry.dos']); t.after(f.close);
  f.configuration.modules = { 'qa::math': '/server/qa/math.dos' };
  await f.commands.get(ids.start).execute({});
  const session = f.instances[0], sourcePath = session.sourcePath('qa::math'), pending = deferred(), sent = deferred();
  f.configuration.source = () => { sent.resolve(); return pending.promise; };
  const opening = f.panel.options.open(session, sourcePath); await sent.promise;
  await session.stop(); await f.commands.get(ids.start).execute({});
  pending.resolve('stale module'); await opening;
  assert.equal(f.opened.length, 0);
  f.configuration.source = async () => 'current module';
  await f.panel.options.open(session, sourcePath);
  assert.equal(f.opened[0].content.model.sharedModel.getSource(), 'current module');
});
