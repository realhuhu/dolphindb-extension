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

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function profile(id, name) {
  return { id, name, host: 'localhost', port: 8848, username: 'user', ssl: false, timeout: 10, rememberPassword: false, hasPassword: false };
}
function fixture({ sessions = [], metadata = async () => [], connect, connectionReady = Promise.resolve() } = {}) {
  const profiles = [profile('default', 'Default'), profile('other', 'Other')];
  const previews = [], requests = [], attachments = [];
  const connections = {
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
    openSdk: async ticket => { attachments.push(ticket); return sdk('session'); },
  };
  const api = { request: async path => {
    requests.push(path);
    if (path === 'dos-sessions') { return { sessions }; }
    const session = sessions.find(s => path.startsWith(`dos-sessions/${s.id}`));
    assert.ok(session, `Unexpected API path: ${path}`);
    return path.endsWith('/attach') ? { path: `${path}/ws` } : { ...session, history: [] };
  } };
  const modules = { '@lumino/signaling': { Signal }, 'dolphindb/browser.js': {}, '../api': api, './runtime': runtime };
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
