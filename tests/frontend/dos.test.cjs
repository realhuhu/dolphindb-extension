const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { Signal } = require('@lumino/signaling');

// Exercise the real model with controlled transport promises, without loading
// Jupyter's browser-only modules or connecting to a database in unit tests.
const compiled = ts.transpileModule(
  readFileSync(resolve(__dirname, '../../frontend/dos/model.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText;
const folding = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(resolve(__dirname, '../../frontend/dos/folding.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, folding);

const tick = () => new Promise(resolve => setImmediate(resolve));

test('global folding defaults affect only new records and preserve document overrides', () => {
  const state = new folding.exports.OutputFolding();
  state.retain(['one']);
  state.setDefault(false); state.retain(['one', 'two']);
  assert.equal(state.expanded('one'), true);
  assert.equal(state.expanded('two'), false);
  state.setExpanded('two', true); state.setDefault(true);
  assert.equal(state.expanded('two'), true);
  state.setAll(false); state.setDefault(true); state.retain(['one', 'two', 'three']);
  assert.equal(state.expanded('three'), false, 'collapse all remains the document preference');
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function profile(id, name) {
  return { id, name, host: 'localhost', port: 8848, username: 'user', ssl: false, timeout: 10, rememberPassword: false, hasPassword: false };
}
function fixture({ sessions = [], metadata = async () => [], connect, connectionReady = Promise.resolve(), tablePreview = async () => ({ kind: 'table', columns: [], rows: [] }), variablePreview = async () => ({ text: '42' }), tableSchema = async () => ({ columns: [], rows: [] }), browse = async () => ({ form: 'VECTOR', type: 'INT', count: 0 }) } = {}) {
  const profiles = [profile('default', 'Default'), profile('other', 'Other')];
  const previews = [], requests = [], attachments = [];
  const connections = {
    preferences: require('./preferences.cjs').preferences(),
    state: { connections: profiles, activeId: 'default' },
    changed: new Signal({}), refresh: async () => { await connectionReady; },
  };
  const sdk = id => ({
    id, ddb: { connected: true }, version: '3.0',
    disconnect() { this.ddb.connected = false; },
  });
  const runtime = {
    previewConnection: async id => {
      const client = sdk(id);
      previews.push(client);
      if (connect) { await connect(client); }
      return client;
    },
    loadDatabases: metadata,
    loadVariables: async () => [],
    tablePreview,
    variablePreview,
    tableSchema,
    openSdk: async ticket => { attachments.push(ticket); return sdk('session'); },
  };
  const api = { request: async path => {
    requests.push(path);
    if (path === 'dos-sessions') { return { sessions }; }
    const session = sessions.find(s => path.startsWith(`dos-sessions/${s.id}`));
    assert.ok(session, `Unexpected API path: ${path}`);
    return path.endsWith('/attach') ? { path: `${path}/ws` } : { ...session, history: [] };
  } };
  const modules = { '@lumino/signaling': { Signal }, 'dolphindb/browser.js': {}, '../api': api, './runtime': runtime, './folding': folding.exports,
    '../data/registry': { snapshotTicket: () => undefined }, '../data/sdk': { remotePage: browse } };
  const sandbox = {
    exports: {}, require: id => {
      assert.ok(Object.hasOwn(modules, id), `Unexpected model import: ${id}`);
      return modules[id];
    },
    window: { setInterval() {} }, performance, TextDecoder, Uint8Array, atob,
  };
  vm.runInNewContext(compiled, sandbox);
  const manager = new sandbox.exports.DosManager(connections);
  return { manager, connections, profiles, previews, requests, attachments };
}

test('output folding preserves old entries on prints/new runs, and collapse-all applies to future entries', () => {
  const state = new folding.exports.OutputFolding();
  assert.equal(state.expanded('session:1'), true);
  state.setExpanded('session:1', false);
  state.retain(['session:1', 'session:2']);
  assert.equal(state.expanded('session:1'), false);
  assert.equal(state.expanded('session:2'), true);
  state.collapsed = true;
  state.setAll(false);
  assert.equal(state.expanded('session:2'), false);
  assert.equal(state.expanded('session:3'), false);
  state.setExpanded('session:2', true);
  assert.equal(state.expanded('session:2'), true);
  assert.equal(state.expanded('session:3'), false);
  assert.equal(state.collapsed, true, 'entry changes cannot reopen the whole panel');
  state.setAll(true);
  state.setExpanded('session:1', false);
  state.retain(['session:2', 'session:3']);
  assert.equal(state.expanded('new-session:1'), true, 'a new session cannot inherit a previous run ID');
});

test('table preview opens a dialog signal without adding output or locking the connection', async () => {
  const value = { kind: 'table', columns: ['id'], rows: [[1]] }, calls = [];
  const f = fixture({ tablePreview: async (_sdk, ...args) => { calls.push(args); return value; } });
  await f.manager.ready;
  const model = f.manager.document('table.dos'); model.open(); await model.initialize();
  const previews = []; model.previewReady.connect((_sender, result) => previews.push(result));
  await model.inspectTable('dfs://test', 'prices');
  assert.deepEqual(calls, [['dfs://test', 'prices', 100]]);
  f.connections.preferences.value.preview.tableRows = 250;
  await model.inspectTable('dfs://test', 'prices');
  assert.deepEqual(calls[1], ['dfs://test', 'prices', 250]);
  assert.equal(previews[1].title, 'prices · 前 250 行');
  assert.equal(previews[0].value, value);
  assert.equal(model.outputs.length, 0); assert.equal(model.locked, false);
  model.folding.collapsed = true;
  model.closeView(); model.open(); await model.initialize();
  assert.equal(model.folding.collapsed, true, 'reopening the editor preserves its fold preference');
  model.closeView();
});

test('changing history limits retains the MIME objects and view state of displayed runs', async () => {
  const session = { id: 'saved', path: 'history.dos', profile: profile('default', 'Default'), locked: true, attached: false, state: 'idle', executionCount: 3 };
  const f = fixture({ sessions: [session] }); await f.manager.ready;
  const model = f.manager.document('history.dos'); model.session = session; model.loadedHistory = 3;
  const outputs = [1, 2, 3].map(id => ({ id: `saved:${id}`, status: 'ok', prints: [], value: { text: String(id) } }));
  model.outputs = outputs;
  f.connections.preferences.value.advanced.historyEntries = 2;
  await model.restore(true);
  assert.equal(model.outputs.length, 2);
  assert.equal(model.outputs[0], outputs[1]);
  assert.equal(model.outputs[1].value, outputs[2].value, 'a settings change must not recreate existing MIME renderers');
});

test('a delayed table preview from a previous connection cannot open a dialog', async () => {
  const pending = deferred();
  const f = fixture({ tablePreview: () => pending.promise }); await f.manager.ready;
  const model = f.manager.document('table.dos'); model.open(); await model.initialize();
  let previews = 0; model.previewReady.connect(() => previews++);
  const request = model.inspectTable('dfs://test', 'prices');
  await model.select('other'); pending.resolve({}); await request;
  assert.equal(previews, 0); model.closeView();
});

test('a live data browser rejects replies from a replaced or newly executing DOS session', async () => {
  for (const change of ['session', 'execution']) {
    const pending = deferred(), session = { id: 'saved', path: 'browse.dos', profile: profile('default', 'Default'), locked: true, state: 'idle', executionCount: 1 };
    const f = fixture({ sessions: [session], browse: () => pending.promise }); await f.manager.ready;
    const model = f.manager.document(session.path); model.open(); await model.initialize();
    const identity = model.browserIdentity();
    const response = assert.rejects(model.browse({kind:'variable',name:'prices'},{path:[],offset:0,limit:100,columnOffset:0}), /变化/);
    model.session = change === 'session' ? {...session,id:'replaced'} : {...session,executionCount:2};
    assert.equal(model.browserIdentity() === identity, change === 'execution');
    pending.resolve({form:'TABLE',type:'TABLE',count:1}); await response; model.closeView();
  }
});

test('table schema hover uses the selected preview without locking or adding execution results', async () => {
  const pending = deferred(), calls = [];
  const value = { columns: ['name', 'typeString'], rows: [['price', 'DOUBLE']], totalRows: 1 };
  const f = fixture({ tableSchema: async (sdk, database, table) => { calls.push([sdk, database, table]); return calls.length === 1 ? value : pending.promise; } });
  await f.manager.ready;
  const model = f.manager.document('schema.dos'); model.open(); await model.initialize();
  assert.equal(await model.previewTableSchema('dfs://test', 'prices'), value);
  assert.equal(calls[0][0], model.sdk); assert.deepEqual(calls[0].slice(1), ['dfs://test', 'prices']);
  assert.equal(model.locked, false); assert.equal(model.outputs.length, 0); assert.equal(model.session, null);
  const response = assert.rejects(model.previewTableSchema('dfs://test', 'prices'), /会话已变化/);
  await model.select('other'); pending.resolve(value); await response;
  assert.equal(model.notice, null); assert.equal(model.outputs.length, 0);
  model.busy = true; await assert.rejects(model.previewTableSchema('dfs://test', 'prices'), /暂不可用/);
  model.closeView();
});

test('variable hover uses only the owning DOS session and does not append an execution result', async () => {
  const calls = [];
  const session = { id: 'saved', path: 'variables.dos', profile: profile('default', 'Default'), locked: true, state: 'idle', executionCount: 1 };
  const value = { columns: ['id', 'value'], rows: [['1', '42']], totalRows: 1 };
  const f = fixture({ sessions: [session], variablePreview: async (ddb, name) => { calls.push([ddb, name]); return value; } });
  await f.manager.ready;
  const model = f.manager.document(session.path); model.open(); await model.initialize();
  model.variables = [{ name: 'counter' }];
  assert.equal(await model.previewVariable('counter'), value);
  assert.equal(calls[0][0], model.connection.ddb); assert.equal(calls[0][1], 'counter');
  assert.equal(model.outputs.length, 0); assert.equal(model.session.executionCount, 1);
  await assert.rejects(model.previewVariable('missing'), /暂不可用/);
  model.busy = true; await assert.rejects(model.previewVariable('counter'), /暂不可用/);
  assert.equal(calls.length, 1);
  model.closeView();
});

test('variable hover discards a reply when the DOS session or its variables change', async () => {
  for (const change of ['session', 'variables', 'run']) {
    const pending = deferred();
    const session = { id: 'saved', path: 'variables.dos', profile: profile('default', 'Default'), locked: true, state: 'idle', executionCount: 1 };
    const f = fixture({ sessions: [session], variablePreview: () => pending.promise }); await f.manager.ready;
    const model = f.manager.document(session.path); model.open(); await model.initialize(); model.variables = [{ name: 'counter' }];
    const response = assert.rejects(model.previewVariable('counter'), /会话已变化/);
    if (change === 'session') { model.session = { ...session, id: 'new' }; }
    if (change === 'variables') { model.variables = [{ name: 'counter' }]; }
    if (change === 'run') { model.session = { ...session, executionCount: 2 }; }
    pending.resolve('old value'); await response; model.closeView();
  }
});

test('batch connection lookup uses the retained session without opening a preview or attaching', async () => {
  const frozen = profile('removed', 'Original session connection');
  const session = { id: 'saved', path: 'closed.dos', profile: frozen, locked: true, attached: false, state: 'idle', executionCount: 1 };
  const f = fixture({ sessions: [session] });
  await f.manager.ready;
  assert.equal(f.manager.profileFor('closed.dos'), frozen);
  assert.equal(f.manager.documents.size, 0);
  assert.equal(f.previews.length, 0);
  assert.equal(f.attachments.length, 0);

  const model = f.manager.document('closed.dos');
  model.open(); await model.initialize();
  assert.equal(model.profile, f.manager.profileFor('closed.dos'));
  assert.equal(f.attachments.length, 1);
  model.closeView();
  assert.equal(model.connection.ddb.connected, true, 'Closing a view preserves its execution session');
});

test('batch connection lookup respects a file selection and the first-profile default', async () => {
  const f = fixture(); await f.manager.ready;
  assert.equal(f.manager.profileFor('new.dos'), f.profiles[0]);
  const model = f.manager.document('selected.dos'); model.open(); await model.initialize();
  await model.select('other');
  assert.equal(f.manager.profileFor(model.path), f.profiles[1]);
  model.closeView();
  f.connections.state.activeId = null;
  assert.equal(f.manager.profileFor('another.dos'), f.profiles[0]);
});

test('closing during metadata loading releases the preview and reopening starts a fresh request', async () => {
  const first = deferred();
  let reads = 0;
  const f = fixture({ metadata: async () => ++reads === 1 ? first.promise : [{ path: 'dfs://new', tables: [] }] });
  await f.manager.ready;
  const model = f.manager.document('slow.dos'); model.open(); await tick();
  const oldInitialization = model.initialize();
  assert.equal(model.loading, true);
  model.closeView();
  assert.equal(model.loading, false);
  assert.equal(f.previews[0].ddb.connected, false);

  model.open(); await model.initialize();
  assert.equal(model.loading, false);
  assert.equal(model.sdk, f.previews[1]);
  first.resolve([{ path: 'dfs://stale', tables: [] }]);
  await oldInitialization;
  assert.equal(model.databases[0].path, 'dfs://new', 'The old request must not overwrite the reopened view');
  assert.equal(model.sdk.ddb.connected, true);
  model.closeView();
});

test('a connection that finishes after its editor closes is disconnected without querying metadata', async () => {
  const pending = deferred();
  let reads = 0;
  const f = fixture({ connect: () => pending.promise, metadata: async () => { reads++; return []; } });
  await f.manager.ready;
  const model = f.manager.document('connecting.dos'); model.open(); await tick();
  const initialization = model.initialize();
  model.closeView(); pending.resolve(); await initialization;
  assert.equal(model.loading, false);
  assert.equal(model.sdk, null);
  assert.equal(f.previews[0].ddb.connected, false);
  assert.equal(reads, 0);
});

test('connection and settings changes do not reopen previews for closed or unopened documents', async () => {
  const f = fixture(); await f.manager.ready;
  const model = f.manager.document('closed.dos'); model.open(); await model.initialize(); model.closeView();
  f.manager.document('unopened.dos');
  for (let i = 0; i < 3; i++) { f.connections.changed.emit(); await tick(); }
  f.connections.state.activeId = 'other'; f.connections.changed.emit(); await tick();
  assert.equal(f.previews.length, 1);
  assert.equal(model.sdk, null);
  model.open(); await model.initialize();
  assert.equal(model.profile.id, 'other');
  assert.equal(f.previews.length, 2);
  model.closeView();
});

test('reopening an unexecuted file retains its manual selection and recreates its preview', async () => {
  const f = fixture(); await f.manager.ready;
  const model = f.manager.document('manual.dos'); model.open(); await model.initialize();
  await model.select('other'); model.closeView();
  model.open(); await model.initialize();
  assert.equal(model.profile.id, 'other');
  assert.equal(model.sdk.id, 'other');
  assert.equal(model.sdk.ddb.connected, true);
  model.closeView();
});

test('closing before the initial connection list arrives does not start a preview', async () => {
  const ready = deferred(); const f = fixture({ connectionReady: ready.promise });
  const model = f.manager.document('startup.dos'); model.open();
  const initialization = model.initialize(); model.closeView();
  ready.resolve(); await initialization;
  assert.equal(f.previews.length, 0);
  assert.equal(model.loading, false);
});
