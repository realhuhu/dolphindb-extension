const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { Signal } = require('@lumino/signaling');

const compiled = ts.transpileModule(
  readFileSync(resolve(__dirname, '../../frontend/notebook/model.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const profile = id => ({ id, name: id, host: 'localhost', port: 8848 });

function kernel({ state = {}, language = 'python', bootstrap } = {}) {
  const initial = { kind: 'state', profile: null, locked: false, busy: false, configuring: false, error: null, ...state };
  const executions = [], comms = [];
  return {
    executions, comms, status: 'idle', info: Promise.resolve({ language_info: { name: language } }),
    requestExecute(options) { executions.push(options); return { done: bootstrap ?? Promise.resolve({ content: { status: 'ok' } }) }; },
    createComm() {
      const comm = {
        sent: [], isDisposed: false, commsOverSubshells: 'perCommTarget', state: { ...initial },
        emit(state) { this.state = { ...this.state, ...state }; this.onMsg({ content: { data: this.state } }); },
        open(data) { this.openedSettings = data.settings; this.openedOn = this.commsOverSubshells; this.emit({}); },
        send(message) {
          this.sent.push(message);
          if (message.kind === 'prepare') { this.emit({ configuring: true }); }
          if (message.kind === 'configure') {
            const { password, ...publicProfile } = message.profile;
            this.emit({ profile: publicProfile, configuring: false, error: null });
          }
          if (message.kind === 'configuration-error') { this.emit({ configuring: false, error: 'Selection failed' }); }
        },
        close() { this.closed = true; }, dispose() { this.isDisposed = true; },
      };
      comms.push(comm); return comm;
    },
  };
}

function fixture({ current = kernel(), request, timers = { setTimeout, clearTimeout } } = {}) {
  const requests = [];
  const connections = { preferences: require('./preferences.cjs').preferences(), state: { connections: [profile('default'), profile('other')], activeId: 'default' }, changed: new Signal({}) };
  const context = { session: { kernel: current }, ready: Promise.resolve(), kernelChanged: new Signal({}), statusChanged: new Signal({}), connectionStatusChanged: new Signal({}) };
  const api = { request: async (path, method, body) => {
    requests.push({ path, method, body });
    assert.equal(path, 'kernel-connection');
    return request ? request(body) : { ...profile(body.connectionId ?? 'default'), password: 'test-only-secret' };
  } };
  const modules = { '@lumino/signaling': { Signal }, '../api': api };
  const sandbox = { exports: {}, crypto: require('node:crypto').webcrypto, ...timers, require: id => { assert.ok(modules[id], id); return modules[id]; } };
  vm.runInNewContext(compiled, sandbox);
  const model = new sandbox.exports.NotebookConnection(context, connections);
  return { model, context, connections, requests, current };
}

test('Python bootstrap uses no history and credentials only travel in a comm', async () => {
  const f = fixture(); await tick();
  assert.equal(f.model.phase, 'ready');
  assert.equal(f.model.profile.id, 'default');
  assert.equal(f.model.selection, '');
  assert.equal(f.current.executions.length, 1);
  assert.equal(f.current.executions[0].silent, true);
  assert.equal(f.current.executions[0].store_history, false);
  assert.equal(f.current.comms[0].openedOn, 'disabled', 'DDB comms and cells must share the SDK session execution queue');
  assert.equal(f.current.comms[0].openedSettings.dataBrowser.pageSize, 100);
  f.connections.preferences.value.dataBrowser.pageSize = 25;
  f.connections.changed.emit();
  assert.equal(f.current.comms[0].sent.at(-1).kind, 'settings');
  assert.equal(f.current.comms[0].sent.at(-1).settings.dataBrowser.pageSize, 25);
  assert.ok(!JSON.stringify(f.current.comms[0].sent.at(-1)).includes('password'));
  assert.ok(!JSON.stringify(f.current.executions).includes('test-only-secret'));
  assert.ok(!JSON.stringify(f.model.profile).includes('test-only-secret'));
  assert.equal(f.current.comms[0].sent.find(m => m.kind === 'configure').profile.password, 'test-only-secret');
  f.model.dispose();
});

test('a restored locked kernel keeps its connection without fetching or resending credentials', async () => {
  const current = kernel({ state: { profile: profile('removed'), locked: true } });
  const f = fixture({ current }); await tick();
  assert.equal(f.model.profile.id, 'removed');
  assert.equal(f.requests.length, 0);
  f.connections.state = { ...f.connections.state, activeId: 'other' }; f.connections.changed.emit();
  await f.model.select('other');
  assert.equal(f.requests.length, 0);
  f.model.dispose();
  assert.equal(current.comms[0].closed, true);
  assert.ok(!current.comms[0].sent.some(m => m.kind === 'close'), 'Closing the view must keep the execution session');
});

test('late connection responses cannot configure a disposed or replaced kernel', async () => {
  const pending = deferred();
  const f = fixture({ request: () => pending.promise }); await tick();
  assert.equal(f.model.loading, true);
  const comm = f.current.comms[0];
  f.model.dispose();
  pending.resolve({ ...profile('default'), password: 'test-only-secret' }); await tick();
  assert.ok(!comm.sent.some(m => m.kind === 'configure'));
});

test('connection selection failures block execution until a successful new selection', async () => {
  let fail = false;
  const f = fixture({ request: body => {
    if (fail) { throw new Error('Profile removed'); }
    return { ...profile(body.connectionId ?? 'default'), password: 'test-only-secret' };
  } }); await tick();
  fail = true; await f.model.select('other');
  assert.equal(f.model.loading, false);
  assert.ok(f.model.notice);
  assert.equal(f.current.comms[0].sent.at(-1).kind, 'configuration-error');
  fail = false; await f.model.select('other');
  assert.equal(f.model.profile.id, 'other');
  assert.equal(f.model.notice, null);
  f.model.dispose();
});

test('kernel restart discards stale bootstrap responses and attaches only to the new kernel', async () => {
  const old = deferred(), next = deferred();
  const f = fixture({ current: kernel({ bootstrap: old.promise }) }); await tick();
  const replacement = kernel({ bootstrap: next.promise });
  f.context.session.kernel = replacement;
  f.context.kernelChanged.emit(); await tick();
  old.resolve({ content: { status: 'ok' } }); await tick();
  const initializing = f.model.initialize();
  assert.equal(replacement.executions.length, 1);
  next.resolve({ content: { status: 'ok' } }); await initializing; await tick();
  assert.equal(f.current.comms.length, 0);
  assert.equal(replacement.comms.length, 1);
  assert.equal(f.model.phase, 'ready');
  f.model.dispose();
});

test('non-Python kernels receive no execution request or credentials', async () => {
  const f = fixture({ current: kernel({ language: 'julia' }) }); await tick();
  assert.equal(f.model.phase, 'unsupported');
  assert.equal(f.current.executions.length, 0);
  assert.equal(f.requests.length, 0);
  f.model.dispose();
});

test('notebook browser identifies the owning DDB session and snapshots survive later executions', async () => {
  for (const kind of ['variable', 'result']) {
    const f = fixture({current:kernel({state:{profile:profile('default'),locked:true,browserOwner:'owner',sessionId:'first'}})}); await tick();
    const pending=deferred(), value={form:'VECTOR',type:'INT',count:3};
    const identity=f.model.browserIdentity();
    f.model.metadata=()=>pending.promise;
    const response=f.model.browse(kind==='result'?{kind,id:'saved'}:{kind,name:'v'},{path:[],offset:0,limit:100,columnOffset:0});
    const check=kind==='variable'?assert.rejects(response,/变化/):response.then(page=>assert.equal(page,value));
    f.model.languageRevision++;
    assert.equal(f.model.browserIdentity(),identity);
    pending.resolve(value); await check;
    f.current.comms[0].emit({sessionId:'second'});
    assert.notEqual(f.model.browserIdentity(),identity);
    assert.equal(f.model.browserOwner,'owner'); f.model.dispose();
  }
});

test('editing an unlocked notebook connection invalidates live browsers and pending data, including password-only edits', async () => {
  for (const manual of [false, true]) {
    const f = fixture(); await tick();
    if (manual) { await f.model.select('other'); }
    const identity = f.model.browserIdentity(), revision = f.model.languageRevision;
    const pending = deferred();
    f.model.metadata = () => pending.promise;
    const response = f.model.browse({kind:'table',database:'dfs://demo',table:'prices'},
      {path:[],offset:0,limit:100,columnOffset:0});
    const rejected = assert.rejects(response, /变化/);
    // Passwords are absent from the public profile; saving still replaces the snapshot.
    f.connections.state = {...f.connections.state}; f.connections.changed.emit(); await tick();
    pending.resolve({form:'TABLE',count:3}); await rejected;
    assert.notEqual(f.model.browserIdentity(), identity);
    assert.ok(f.model.languageRevision > revision);
    assert.equal(f.requests.at(-1).body.connectionId, manual ? 'other' : undefined);
    f.model.dispose();
  }
});

test('a connection reconfigured by another view invalidates preview identity on prepare and acknowledgement', async () => {
  const f = fixture(); await tick();
  const comm = f.current.comms[0], identity = f.model.browserIdentity(), revision = f.model.languageRevision;
  comm.emit({configuring:true});
  assert.notEqual(f.model.browserIdentity(), identity);
  assert.ok(f.model.languageRevision > revision);
  const preparing = f.model.browserIdentity();
  comm.emit({configuring:false});
  assert.notEqual(f.model.browserIdentity(), preparing);
  const locked = {profile:profile('default'),locked:true,sessionId:'fixed-session'};
  comm.emit(locked);
  const session = f.model.browserIdentity(), requests = f.requests.length;
  f.connections.state = {...f.connections.state}; f.connections.changed.emit(); await tick();
  assert.equal(f.model.browserIdentity(), session);
  assert.equal(f.requests.length, requests);
  f.model.dispose();
});

test('reopening during a pending selection completes the requested connection rather than the old one', async () => {
  const f = fixture({ current: kernel({ state: { profile: profile('default'), configuring: true, requestedId: 'other' } }) });
  await tick();
  assert.equal(f.requests[0].body.connectionId, 'other');
  assert.equal(f.model.profile.id, 'other');
  assert.equal(f.model.loading, false);
  f.model.dispose();
});

test('kernel restart preserves the notebook choice instead of reverting to the global default', async () => {
  const f = fixture(); await tick();
  await f.model.select('other');
  f.context.session.kernel = kernel();
  f.context.kernelChanged.emit(); await tick();
  assert.equal(f.requests.at(-1).body.connectionId, 'other');
  assert.equal(f.model.profile.id, 'other');
  f.model.dispose();
});

test('execution readiness waits for connection configuration acknowledgement', async () => {
  const pending = deferred();
  const f = fixture({ request: () => pending.promise });
  let ready = false;
  const waiting = f.model.readyForExecution().then(() => { ready = true; });
  await tick(); assert.equal(ready, false);
  pending.resolve({ ...profile('default'), password: 'test-only-secret' });
  await waiting;
  assert.equal(ready, true);
  f.model.dispose();
});

test('dependent metadata queries wait for the comm request to finish and the kernel to become idle', async () => {
  const f = fixture(); await tick();
  const comm = f.current.comms[0], done = deferred();
  let request;
  comm.send = message => { request = message; return { done: done.promise, dispose() {} }; };
  let resolved = false;
  const response = f.model.metadata('snapshot').then(value => { resolved = true; return value; });
  f.current.status = 'busy';
  comm.onMsg({ content: { data: { kind: 'metadata', id: request.id, result: ['first'] } } });
  await tick(); assert.equal(resolved, false);
  f.current.status = 'idle'; done.resolve();
  assert.deepEqual(await response, ['first']);
  f.model.dispose();
});

function clock() {
  let now = 0, next = 0;
  const jobs = new Map();
  return {
    jobs,
    setTimeout(callback, delay) { const id = ++next; jobs.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    advance(delay) {
      now += delay;
      for (const [id, job] of [...jobs]) {
        if (job.at <= now && jobs.delete(id)) { job.callback(); }
      }
    }
  };
}

function metadataComm(f) {
  const comm = f.current.comms[0], done = deferred();
  let request;
  const future = { done: done.promise, disposed: false,
    dispose() { this.disposed = true; done.reject(new Error('Future disposed')); } };
  comm.send = message => { request = message; return future; };
  return { future, done,
    start() { future.onIOPub({ header: { msg_type: 'status' }, content: { execution_state: 'busy' } }); },
    reply(result) { comm.onMsg({ content: { data: { kind: 'metadata', id: request.id, result } } }); }
  };
}

test('configured metadata timeout and request preferences reach the owning kernel', async () => {
  const timers = clock(), f = fixture({ timers }); await tick();
  f.connections.preferences.value.advanced.metadataTimeout = 12;
  f.connections.preferences.value.preview.tableRows = 250;
  const comm = f.current.comms[0];
  let payload;
  const done = deferred();
  comm.send = message => { payload = message; return { done: done.promise, dispose() { done.reject(new Error('disposed')); } }; };
  const pending = f.model.metadata('tablePreview', { database: 'dfs://test', table: 't' });
  const rejected = assert.rejects(pending, /超时/);
  assert.equal(payload.settings.preview.tableRows, 250);
  timers.advance(11999); await tick();
  assert.equal(f.model.metadataRequests.size, 1);
  timers.advance(1); await rejected;
  assert.equal(f.model.metadataRequests.size, 0);
  f.model.dispose();
});

test('metadata timeout excludes time queued behind user cell execution', async () => {
  const timers = clock(), f = fixture({ timers }); await tick();
  const rpc = metadataComm(f);
  let settled = false;
  const response = f.model.metadata('workspace').then(value => { settled = true; return value; });
  f.current.status = 'busy'; f.context.statusChanged.emit('busy');
  timers.advance(10_000); await tick();
  assert.equal(settled, false);
  f.current.status = 'idle'; f.context.statusChanged.emit('idle');
  rpc.start();
  f.current.status = 'busy'; f.context.statusChanged.emit('busy');
  timers.advance(3999); await tick();
  rpc.reply(['own-session']); rpc.done.resolve();
  assert.deepEqual(await response, ['own-session']);
  assert.equal(timers.jobs.size, 0);
  f.model.dispose();
});

test('metadata execution still times out and disposes a silent request', async () => {
  const timers = clock(), f = fixture({ timers }); await tick();
  const rpc = metadataComm(f);
  const response = assert.rejects(f.model.metadata('snapshot'), /元数据读取超时/);
  rpc.start(); f.context.statusChanged.emit('busy');
  timers.advance(4000); await response;
  assert.equal(rpc.future.disposed, true);
  assert.equal(timers.jobs.size, 0);
  f.model.dispose();
});

test('restart cancels metadata even when a reply arrived before its idle event', async () => {
  const timers = clock(), f = fixture({ timers }); await tick();
  const rpc = metadataComm(f);
  const response = assert.rejects(f.model.metadata('snapshot'), /会话已变化/);
  rpc.reply(['old-session']);
  f.context.statusChanged.emit('restarting');
  await response;
  assert.equal(rpc.future.disposed, true);
  assert.equal(timers.jobs.size, 0);
  f.model.dispose();
});

test('a comm future failure rejects metadata immediately and clears its timer', async () => {
  const timers = clock(), f = fixture({ timers }); await tick();
  const rpc = metadataComm(f);
  const failure = new Error('Kernel restarted');
  const response = assert.rejects(f.model.metadata('snapshot'), caught => caught === failure);
  rpc.done.reject(failure); await response;
  assert.equal(timers.jobs.size, 0);
  f.model.dispose();
});

test('a missing idle event remains bounded after the metadata reply', async () => {
  const timers = clock(), f = fixture({ timers }); await tick();
  const rpc = metadataComm(f);
  const response = assert.rejects(f.model.metadata('snapshot'), /元数据读取超时/);
  rpc.start(); rpc.reply(['old-session']);
  timers.advance(4000); await response;
  assert.equal(rpc.future.disposed, true);
  f.model.dispose();
});

test('disconnect cancels in-flight metadata without changing the locked DDB session', async () => {
  const timers = clock(), f = fixture({ timers, current: kernel({ state: { profile: profile('default'), locked: true } }) });
  await tick();
  const rpc = metadataComm(f);
  const response = assert.rejects(f.model.metadata('snapshot'), /会话已变化/);
  f.context.connectionStatusChanged.emit('connecting');
  await response;
  assert.equal(rpc.future.disposed, true);
  assert.equal(timers.jobs.size, 0);
  assert.equal(f.model.locked, true);
  assert.equal(f.model.profile.id, 'default');
  f.model.dispose();
});

test('synchronous comm send failure removes the pending request and timeout', async () => {
  const timers = clock(), f = fixture({ timers }); await tick();
  f.current.comms[0].send = () => { throw new Error('Cannot send'); };
  await assert.rejects(f.model.metadata('snapshot'), /Cannot send/);
  assert.equal(timers.jobs.size, 0);
  f.model.dispose();
});

const workspace = name => ({ databases: [{ path: `dfs://${name}`, tables: ['prices'] }],
  variables: [{ name, type: 'INT', form: 'SCALAR', rows: 1, columns: 1, bytes: '4', value: '7' }],
  databaseError: null, variablesError: null });

test('notebook variable hover uses the metadata comm and rejects stale replies after execution or closing', async () => {
  for (const change of ['none', 'run', 'close', 'refresh']) {
    const f = fixture({ current: kernel({ state: { profile: profile('default'), locked: true } }) }); await tick();
    f.model.variables = workspace('counter').variables;
    const pending = deferred(), calls = [];
    f.model.metadata = (operation, args) => { calls.push([operation, args.name]); return pending.promise; };
    const request = f.model.previewVariable('counter');
    const checked = change === 'none' ? request : assert.rejects(request, /会话已变化/);
    if (change === 'run') { f.current.comms[0].emit({ busy: true }); f.current.comms[0].emit({ busy: false }); }
    if (change === 'close') { f.current.comms[0].emit({ locked: false }); }
    if (change === 'refresh') { f.model.variables = workspace('counter').variables; }
    const value = { columns: ['键', '值'], rows: [['counter', '42']], totalRows: 1 };
    pending.resolve(value);
    if (change === 'none') { assert.equal(await checked, value); } else { await checked; }
    assert.deepEqual(calls, [['variablePreview', 'counter']]);
    assert.equal(f.current.executions.length, 1, 'hover must not send execute_request or write Python history');
    f.model.dispose();
  }
});

test('notebook table schema uses metadata before and after execution and rejects changed connections', async () => {
  for (const locked of [false, true]) {
    const f = fixture({ current: kernel({ state: { profile: profile('default'), locked } }) }); await tick();
    const value = { columns: ['name', 'typeString'], rows: [['id', 'INT']], totalRows: 1 };
    const pending = deferred(), calls = [];
    f.model.metadata = (operation, args) => { calls.push([operation, args.database, args.table]); return calls.length === 1 ? Promise.resolve(value) : pending.promise; };
    assert.equal(await f.model.previewTableSchema('dfs://market', 'prices'), value);
    assert.equal(f.model.locked, locked); assert.equal(f.current.executions.length, 1);
    assert.deepEqual(calls[0], ['tableSchema', 'dfs://market', 'prices']);
    const response = assert.rejects(f.model.previewTableSchema('dfs://market', 'prices'), /会话已变化/);
    f.current.comms[0].emit({ profile: profile('other'), locked: false }); pending.resolve(value); await response;
    f.model.dispose();
  }
});

test('reconnecting refreshes panels even if the connection and lock state have not changed', async () => {
  const f = fixture({ current: kernel({ state: { profile: profile('default'), locked: true } }) }); await tick();
  let reads = 0;
  f.model.metadata = async () => workspace(`revision-${++reads}`);
  f.model.setPanelActive(true); await tick();
  assert.equal(reads, 1);
  f.context.connectionStatusChanged.emit('connecting');
  f.context.connectionStatusChanged.emit('connected');
  f.current.comms[0].emit({}); await tick();
  assert.equal(reads, 2);
  assert.equal(f.model.variables[0].name, 'revision-2');
  assert.equal(f.model.locked, true);
  f.context.statusChanged.emit('idle'); await tick();
  assert.equal(reads, 2, 'Metadata idle must not trigger a refresh loop');
  f.model.dispose();
});

test('notebook panel previews stay switchable and executions refresh only after kernel idle', async () => {
  const f = fixture(); await tick();
  const requests = [];
  f.model.metadata = async (operation, args) => { requests.push({ operation, args }); return workspace(f.model.profile.id); };
  f.model.setPanelActive(true); await tick();
  assert.equal(requests[0].operation, 'workspace');
  assert.equal(requests[0].args.includeVariables, 'false');
  assert.equal(f.model.databases[0].path, 'dfs://default');
  assert.equal(f.model.variables.length, 0);
  assert.equal(f.model.locked, false);
  f.current.status = 'busy';
  f.current.comms[0].emit({ locked: true, busy: true });
  f.current.comms[0].emit({ busy: false });
  await tick(); assert.equal(requests.length, 1);
  f.current.status = 'idle'; f.context.statusChanged.emit('idle'); await tick();
  assert.equal(requests[1].args.includeVariables, 'true');
  assert.equal(f.model.variables[0].name, 'default');
  // Metadata comm messages also emit idle; they must not cause a refresh loop.
  f.context.statusChanged.emit('idle'); await tick();
  assert.equal(requests.length, 2);
  f.model.dispose();
});

test('switching connections discards pending panel responses and closing clears session variables', async () => {
  const f = fixture(); await tick();
  const old = deferred(); let calls = 0;
  f.model.metadata = async () => ++calls === 1 ? old.promise : workspace(f.model.profile.id);
  f.model.setPanelActive(true); await tick();
  await f.model.select('other');
  old.resolve(workspace('old')); await tick(); await tick();
  assert.equal(f.model.databases[0].path, 'dfs://other');
  f.current.comms[0].emit({ locked: true }); await tick();
  assert.equal(f.model.variables[0].name, 'other');
  f.current.comms[0].emit({ locked: false }); await tick();
  assert.equal(f.model.variables.length, 0);
  assert.equal(f.model.databases[0].path, 'dfs://other');
  f.context.statusChanged.emit('restarting');
  assert.equal(f.model.databases.length, 0);
  assert.equal(f.model.variables.length, 0);
  f.model.dispose();
});

test('inactive notebook panels defer refresh and different kernels retain their own variables', async () => {
  const a = fixture(), b = fixture(); await tick();
  a.model.metadata = async () => workspace('kernelA');
  b.model.metadata = async () => workspace('kernelB');
  a.current.comms[0].emit({ locked: true }); b.current.comms[0].emit({ locked: true });
  a.model.setPanelActive(true); await tick();
  assert.equal(a.model.variables[0].name, 'kernelA');
  assert.equal(b.model.variables.length, 0);
  a.model.setPanelActive(false); b.model.setPanelActive(true); await tick();
  assert.equal(b.model.variables[0].name, 'kernelB');
  assert.equal(a.model.variables[0].name, 'kernelA');
  a.model.dispose(); b.model.dispose();
});

const executorSandbox = { exports: {} };
vm.runInNewContext(ts.transpileModule(
  readFileSync(resolve(__dirname, '../../frontend/notebook/executor.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText, executorSandbox);
const { withDdbReadiness } = executorSandbox.exports;

function cellOptions(source, notebook, context = {}) {
  return { source, notebook, sessionContext: context, cell: { model: { type: 'code', sharedModel: { getSource: () => source } } }, onCellExecuted() {} };
}
function notebookWith(...sources) {
  return { sharedModel: { cells: sources.map(source => ({ cell_type: 'code', getSource: () => source })) } };
}

test('all cells in a mixed notebook wait together and retain native execution order', async () => {
  const gate = deferred(), calls = [];
  const executor = withDdbReadiness({ runCell: async options => { calls.push(options.source); return true; } },
    () => ({ readyForExecution: () => gate.promise }));
  const notebook = notebookWith('aaa=%ddb 1 + 1', 'assert aaa == 2');
  const context = {};
  const executions = ['aaa=%ddb 1 + 1', 'assert aaa == 2'].map(source => executor.runCell(cellOptions(source, notebook, context)));
  await tick(); assert.deepEqual(calls, []);
  gate.resolve(); await Promise.all(executions);
  assert.deepEqual(calls, ['aaa=%ddb 1 + 1', 'assert aaa == 2']);
});

test('Python strings, comments and other magics go untouched to IPython without a DDB connection', async () => {
  const f = fixture({ request: () => { throw new Error('No DDB profiles'); } });
  const sources = ['print(1)', 'example = "aaa=%ddb 1 + 1"', 'help = """\n%ddb 1 + 1\n"""', '# %%ddb comment', '%sql SELECT 1'];
  const calls = [];
  const executor = withDdbReadiness({ runCell: async options => { calls.push(options.source); return true; } }, () => f.model);
  for (const source of sources) {
    const options = cellOptions(source, notebookWith(source), f.context);
    options.cell.model.sharedModel.getSource = () => { throw new Error('Frontend must not parse cell code'); };
    assert.equal(await executor.runCell(options), true);
  }
  assert.deepEqual(calls, sources);
  assert.ok(f.model.notice);
  f.model.dispose();
});

test('missing kernel installation is not retried on every ordinary Python execution', async () => {
  const f = fixture({ current: kernel({ bootstrap: Promise.resolve({ content: { status: 'error' } }) }) });
  await f.model.readyForExecution();
  assert.equal(f.model.phase, 'error');
  await f.model.readyForExecution();
  assert.equal(f.current.executions.length, 1);
  f.model.dispose();
});

test('DDB errors use the native cell executor even when configuration failed', async () => {
  const f = fixture({ request: () => { throw new Error('No DDB profiles'); } });
  const error = new Error('KernelReplyNotOK: UsageError');
  const executor = withDdbReadiness({ runCell: async () => { throw error; } }, () => f.model);
  const options = cellOptions('%ddb writeToDatabase()', notebookWith('%ddb writeToDatabase()'), f.context);
  await assert.rejects(executor.runCell(options), caught => caught === error);
  f.model.dispose();
});
