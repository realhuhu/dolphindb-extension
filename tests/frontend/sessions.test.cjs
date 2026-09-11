const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { Signal } = require('@lumino/signaling');

const compiled = ts.transpileModule(readFileSync(resolve(__dirname, '../../frontend/notebook/sessions.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
const state = () => ({ kind: 'state', locked: true, busy: false, error: null, profile: { id: 'local', name: 'Local' } });
const commInfo = comms => ({ content: { status: 'ok', comms } });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function shellFuture(reply, message) {
  const canceled = deferred();
  const future = { msg: message, isDisposed: false, done: Promise.race([reply, canceled.promise]),
    dispose() { future.isDisposed = true; canceled.reject(new Error('Canceled future')); },
  };
  // Match Jupyter's disposeOnDone behavior, including disposal rejecting an unfinished future.
  void future.done.then(() => { future.isDisposed = true; }, () => { future.isDisposed = true; });
  return future;
}

function fixture({ target = 'dolphindb-extension:running-session', paths = ['demo.ipynb'], discover } = {}) {
  let records = paths.map((path, index) => ({ id: String(index), path, type: 'notebook', kernel: { id: 'python' } }));
  let kernels = [{ id: 'python', name: 'python3' }];
  const connections = [], options = [];
  const services = {
    sessions: { ready: Promise.resolve(), runningChanged: new Signal({}), running: () => records.values(), refreshRunning: async () => {} },
    kernels: { ready: Promise.resolve(), runningChanged: new Signal({}), running: () => kernels.values(), refreshRunning: async () => {}, connectTo: config => {
      options.push(config);
      const kernel = { ...config.model, username: 'user', clientId: 'observer', connectionStatus: 'connected', status: 'idle',
        statusChanged: new Signal({}), connectionStatusChanged: new Signal({}), iopubMessage: new Signal({}),
        comms: target ? { marker: { target_name: target } } : {}, state: state(), reads: 0, sent: [], futures: [], isDisposed: false,
        discover: discover ?? (() => Promise.resolve(commInfo(kernel.comms))),
        sendComm: message => {
          if (message.content.data.kind === 'close') { kernel.state.locked = false; }
          kernel.emit({ header: { msg_type: 'comm_msg' }, content: { comm_id: message.content.comm_id, data: { ...kernel.state } } });
          return Promise.resolve();
        },
        sendShellMessage: (message, expectReply, disposeOnDone) => {
          assert.equal(message.channel, 'shell');
          assert.equal(message.header.subshell_id, undefined);
          assert.equal(disposeOnDone, true);
          let reply;
          if (message.header.msg_type === 'comm_info_request') {
            assert.equal(expectReply, true);
            kernel.reads++; reply = kernel.discover();
          } else {
            assert.equal(message.header.msg_type, 'comm_msg');
            assert.equal(expectReply, false);
            kernel.sent.push(message.content.data.kind);
            reply = kernel.sendComm(message);
          }
          const future = shellFuture(reply, message);
          kernel.futures.push(future); return future;
        },
        emit: message => kernel.iopubMessage.emit(message),
        dispose: () => { kernel.isDisposed = true; },
      };
      connections.push(kernel); return kernel;
    } },
  };
  const sandbox = { exports: {}, require: id => {
    if (id === '@lumino/signaling') { return { Signal }; }
    assert.equal(id, '@jupyterlab/services');
    return { KernelMessage: {
      createMessage: ({ msgType, ...options }) => ({ ...options, header: { msg_type: msgType } }),
      isCommCloseMsg: msg => msg.header.msg_type === 'comm_close', isCommMsgMsg: msg => msg.header.msg_type === 'comm_msg',
      isCommOpenMsg: msg => msg.header.msg_type === 'comm_open',
    } };
  } };
  vm.runInNewContext(compiled, sandbox);
  const manager = new sandbox.exports.NotebookSessions(services);
  return { manager, services, connections, options, poll: () => manager.refresh(), rename: () => { records[0].path = 'renamed.ipynb'; },
    remove: () => { records = []; kernels = []; services.kernels.runningChanged.emit(); } };
}

test('Notebook running sessions survive without a document view and deduplicate shared Python kernels', async () => {
  const f = fixture({ paths: ['demo.ipynb', 'shared.ipynb'] }); await tick();
  assert.equal(f.connections.length, 1);
  assert.equal(f.options[0].handleComms, false, 'an observer must not consume/close notebook widget comms');
  assert.equal(f.manager.sessions.length, 1);
  assert.deepEqual(Array.from(f.manager.sessions[0].paths), ['demo.ipynb', 'shared.ipynb']);
  f.rename(); await f.manager.refresh(); await tick();
  assert.equal(f.manager.sessions[0].paths[0], 'renamed.ipynb');
  await f.manager.shutdown('python');
  assert.equal(f.manager.sessions.length, 0);
  assert.ok(f.connections[0].sent.includes('close'));
  assert.equal(f.connections[0].isDisposed, false, 'closing DDB must keep the Python connection/kernel');
  f.manager.dispose(); assert.equal(f.connections[0].isDisposed, true);
});

test('ordinary notebooks and preview-only DDB connections are not shown as running DDB sessions', async () => {
  const f = fixture({ target: null }); await tick();
  assert.equal(f.manager.sessions.length, 0); assert.equal(f.connections[0].sent.length, 0);
  f.connections[0].comms = { marker: { target_name: 'dolphindb-extension:notebook' } };
  f.connections[0].state.locked = false;
  f.poll(); await tick(); assert.equal(f.manager.sessions.length, 0);
  f.connections[0].state.locked = true;
  f.poll(); await tick(); assert.equal(f.manager.sessions.length, 1, 'existing older-version notebook comms remain discoverable');
  f.manager.dispose();
});

test('kernel restart/shutdown removes DDB sessions and transport disconnect preserves their last state', async () => {
  const f = fixture(); await tick();
  const kernel = f.connections[0];
  kernel.connectionStatus = 'disconnected'; kernel.connectionStatusChanged.emit('disconnected');
  f.poll(); await tick(); assert.equal(f.manager.sessions.length, 1);
  kernel.connectionStatus = 'connected'; kernel.connectionStatusChanged.emit('connected'); await tick();
  kernel.statusChanged.emit('restarting'); assert.equal(f.manager.sessions.length, 0);
  kernel.comms = {}; f.poll(); await tick(); assert.equal(f.manager.sessions.length, 0);
  f.remove(); assert.equal(kernel.isDisposed, true);
  f.manager.dispose();
});

test('busy kernels have at most one pending discovery and cannot block other refreshes', async () => {
  const f = fixture(); await tick();
  const kernel = f.connections[0]; let finish;
  kernel.discover = () => new Promise(resolve => { finish = resolve; });
  const reads = kernel.reads;
  const pending = Array.from({ length: 5 }, () => f.poll()); await tick();
  assert.equal(kernel.reads, reads + 1);
  f.remove();
  finish({ content: { status: 'ok', comms: { marker: { target_name: 'dolphindb-extension:running-session' } } } }); await tick();
  await Promise.all(pending);
  assert.equal(f.manager.sessions.length, 0, 'a stale discovery reply cannot restore a shut-down kernel');
  f.manager.dispose();
});

test('new DDB sessions use pushed notifications without polling the shell or interfering with idle culling', async () => {
  const f = fixture({ target: null }); await tick();
  const kernel = f.connections[0], reads = kernel.reads;
  kernel.emit({ header: { msg_type: 'comm_msg' }, content: { comm_id: 'new-marker', data: { ...state(), kind: 'running-session' } } });
  assert.equal(f.manager.sessions.length, 1);
  for (let i = 0; i < 5; i++) { f.services.sessions.runningChanged.emit(); kernel.statusChanged.emit('idle'); }
  await tick(); assert.equal(kernel.reads, reads);
  assert.equal(kernel.sent.length, 0);
  kernel.emit({ header: { msg_type: 'comm_close' }, content: { comm_id: 'new-marker' } });
  assert.equal(f.manager.sessions.length, 0);
  f.manager.dispose();
});

test('an older discovery reply cannot erase a newly pushed DDB session', async () => {
  const f = fixture({ target: null }); await tick();
  const kernel = f.connections[0]; let finish;
  kernel.discover = () => new Promise(resolve => { finish = resolve; });
  const pending = f.manager.refresh(); await tick();
  kernel.emit({ header: { msg_type: 'comm_msg' }, content: { comm_id: 'new-marker', data: { ...state(), kind: 'running-session' } } });
  finish({ content: { status: 'ok', comms: {} } }); await pending;
  assert.equal(f.manager.sessions.length, 1);
  f.manager.dispose();
});

test('reconnect cancels a lost discovery and finds existing DDB sessions without reloading the page', async () => {
  const f = fixture({ discover: () => new Promise(() => {}) }); await tick();
  const kernel = f.connections[0], lost = kernel.futures[0];
  let refreshed = false;
  const refresh = f.manager.refresh().then(() => { refreshed = true; }); await tick();
  assert.equal(kernel.reads, 1); assert.equal(f.manager.sessions.length, 0);
  kernel.connectionStatus = 'connecting'; kernel.connectionStatusChanged.emit('connecting');
  await tick();
  assert.equal(lost.isDisposed, true, 'a lost request must release its Jupyter future');
  assert.equal(refreshed, true, 'callers awaiting discovery must also be released');
  await refresh;
  kernel.discover = () => Promise.resolve(commInfo(kernel.comms));
  kernel.connectionStatus = 'connected'; kernel.connectionStatusChanged.emit('connected'); await tick();
  assert.equal(kernel.reads, 2); assert.equal(f.manager.sessions.length, 1);
  await f.manager.refresh();
  assert.equal(kernel.reads, 3, 'manual refresh works after reconnect');
  f.manager.dispose();
});

test('a late old discovery reply or rejection cannot clear the replacement discovery', async () => {
  for (const outcome of ['ready', 'reply', 'error']) {
    const old = deferred(), current = deferred();
    const f = fixture({ discover: () => old.promise }); await tick();
    const kernel = f.connections[0];
    kernel.discover = () => current.promise;
    if (outcome === 'ready') {
      old.resolve(commInfo({ stale: { target_name: 'dolphindb-extension:notebook' } }));
      // The future has completed, but the async probe has not consumed its reply yet.
      await Promise.resolve();
    }
    kernel.connectionStatus = 'disconnected'; kernel.connectionStatusChanged.emit('disconnected');
    kernel.connectionStatus = 'connected'; kernel.connectionStatusChanged.emit('connected');
    if (outcome === 'reply') { old.resolve(commInfo({ stale: { target_name: 'dolphindb-extension:notebook' } })); }
    else if (outcome === 'error') { old.reject(new Error('Lost transport')); }
    await tick();
    const refresh = f.manager.refresh(); await tick();
    assert.equal(kernel.reads, 2, 'old cleanup must not allow duplicate discovery while the new request is pending');
    assert.equal(kernel.sent.length, 0, 'a stale reply must not request state from an old comm');
    current.resolve(commInfo(kernel.comms)); await refresh;
    assert.equal(f.manager.sessions.length, 1);
    assert.equal(f.manager.sessions[0].commId, 'marker');
    f.manager.dispose();
  }
});

test('disconnect also cancels a lost status response after comm discovery', async () => {
  const f = fixture({ target: null }); await tick();
  const kernel = f.connections[0], sendComm = kernel.sendComm;
  kernel.comms = { marker: { target_name: 'dolphindb-extension:running-session' } };
  kernel.sendComm = () => new Promise(() => {});
  let refreshed = false;
  const refresh = f.manager.refresh().then(() => { refreshed = true; }); await tick();
  const lost = kernel.futures.at(-1);
  assert.equal(lost.msg.header.msg_type, 'comm_msg');
  kernel.connectionStatus = 'disconnected'; kernel.connectionStatusChanged.emit('disconnected'); await tick();
  assert.equal(lost.isDisposed, true); assert.equal(refreshed, true); await refresh;
  kernel.sendComm = sendComm;
  kernel.connectionStatus = 'connected'; kernel.connectionStatusChanged.emit('connected'); await tick();
  assert.equal(f.manager.sessions.length, 1);
  f.manager.dispose();
});

test('restart, kernel removal and manager disposal release unfinished discoveries', async () => {
  for (const action of ['restart', 'remove', 'dispose']) {
    const f = fixture({ discover: () => new Promise(() => {}) }); await tick();
    const kernel = f.connections[0], lost = kernel.futures[0];
    let refreshed = false;
    const refresh = f.manager.refresh().then(() => { refreshed = true; }); await tick();
    if (action === 'restart') { kernel.statusChanged.emit('restarting'); }
    else if (action === 'remove') { f.remove(); }
    else { f.manager.dispose(); }
    await tick();
    assert.equal(lost.isDisposed, true, action); assert.equal(refreshed, true, action); await refresh;
    assert.equal(f.manager.sessions.length, 0);
    f.manager.dispose();
  }
});
