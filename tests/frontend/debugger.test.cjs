const assert = require('node:assert/strict');
const test = require('node:test');
const { dataLoader } = require('./load-data.cjs');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const profile = { id: 'local', name: 'Test', host: 'localhost', port: 8848, username: '', timeout: 2 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function message(data, blocks = []) {
  const json = new TextEncoder().encode(JSON.stringify(data));
  const buffer = new Uint8Array(4 + json.length + blocks.reduce((n, b) => n + b.length, 0));
  new DataView(buffer.buffer).setUint32(0, json.length, true); buffer.set(json, 4);
  let at = 4 + json.length; for (const block of blocks) { buffer.set(block, at); at += block.length; }
  return buffer.buffer;
}
async function fixture(overrides = {}) {
  const sdk = await import('dolphindb/browser.js'), load = dataLoader(sdk);
  const calls = [], locks = [];
  let events;
  const remote = { connect: async () => {}, close() { this.closed = true; },
    call: async (func, args) => {
      calls.push([func, args]);
      if (overrides[func]) { return overrides[func](args); }
      if (func === 'parseScriptWithDebug') { return { modules: {} }; }
      if (func === 'setBreaks') { return [args[0], args[1].filter(line => line !== 0)]; }
      if (func === 'stackTrace') { return [{ stackFrameId: 0, line: 1, moduleName: '' }]; }
      if (func === 'getStackVariables') { return [{ name: 't', type: 'INT', form: 'VECTOR', vid: 0 }]; }
    } };
  const host = { source: () => 'a=1\nb=2', ticket: overrides.ticket ?? (async () => ({ path: 'ticket', username: '', password: 'secret', timeout: 2 })), url: path => path, locked: value => locks.push(value) };
  const session = new (load('debugger/session').DosDebugSession)('one.dos', host, (_url, _timeout, event) => { events = event; return remote; });
  return { session, calls, locks, remote, event: message => events(message) };
}

test('debug protocol decodes multiple binary variable blocks and rejects truncated offsets', async () => {
  const sdk = await import('dolphindb/browser.js'), { parseDebugMessage } = dataLoader(sdk)('debugger/remote');
  const first = new sdk.DdbInt(0).pack(), second = new sdk.DdbBool(false).pack();
  const parsed = parseDebugMessage(message({ id: 0, message: 'OK', data: [{ name: 'zero', offset: first.length }, { name: 'false', offset: second.length }, { name: 'large', offset: -1 }] }, [first, second]));
  assert.equal(parsed.data[0].ddbValue.value, 0); assert.equal(parsed.data[1].ddbValue.value, false);
  assert.equal(parsed.data[2].ddbValue, undefined);
  assert.throws(() => parseDebugMessage(message({ message: 'OK', data: { offset: 200 } })), /长度/);
  assert.throws(() => parseDebugMessage(new ArrayBuffer(3)), /不完整/);
});

test('debug RPCs are serial; server errors settle and disconnect rejects queued requests', async () => {
  const sdk = await import('dolphindb/browser.js'), { DebugRemote } = dataLoader(sdk)('debugger/remote');
  const socket = { readyState: 1, sent: [], send(data) { this.sent.push(data); }, close() {} };
  const remote = new DebugRemote('ws://test', 200, () => {}, () => {}, () => socket);
  const connected = remote.connect('', ''); socket.onopen(); await connected;
  const a = remote.call('first'), b = remote.call('second');
  const failure = assert.rejects(a, /bad script/); await tick(); assert.equal(socket.sent.length, 1);
  socket.onmessage({ data: message({ id: 0, message: 'bad script' }) }); await failure; await tick();
  assert.equal(socket.sent.length, 2); socket.onmessage({ data: message({ id: 1, message: 'OK', data: 42 }) }); assert.equal(await b, 42);
  const c = remote.call('third'), d = remote.call('fourth');
  const closed = [assert.rejects(c, /关闭|断开/), assert.rejects(d, /关闭|断开/)]; await tick(); socket.onclose(); await Promise.all(closed);
});

test('debug RPC timeout closes the socket and releases the serial queue', async () => {
  const sdk = await import('dolphindb/browser.js'), { DebugRemote } = dataLoader(sdk)('debugger/remote');
  let closed = false;
  const socket = { readyState: 1, send() {}, close() { closed = true; } };
  const remote = new DebugRemote('ws://test', 20, () => {}, () => {}, () => socket);
  const connected = remote.connect('', ''); socket.onopen(); await connected;
  await Promise.all([assert.rejects(remote.call('hang'), /超时/), assert.rejects(remote.call('queued'), /关闭/)]);
  assert(closed);
});

test('DOS debugger verifies breakpoints before running and accepts frame/variable id zero', async () => {
  const { session, calls, event, locks } = await fixture({ getVariable: async args => { assert.deepEqual(Array.from(args), [0, 0, 't']); return { name: 't', data: 0 }; } });
  await session.setBreakpoints('one.dos', [0, 1]); await session.start(profile);
  assert.deepEqual(calls.map(c => c[0]), ['parseScriptWithDebug', 'setBreaks', 'setAllExceptionBreak', 'runScriptWithDebug']);
  assert.equal(session.breaks.get('one.dos')[0].verified, false); assert.equal(session.breaks.get('one.dos')[1].verified, true);
  event({ event: 'BREAKPOINT', message: 'OK', data: { line: 1, moduleName: '' } }); await tick();
  assert.equal(session.frame.stackFrameId, 0); assert.equal((await session.variable(session.variables[0])).data, 0);
  await session.stop(); assert.deepEqual(locks, [true, false]); assert.equal(session.active, false);
});

test('manual pause acknowledgement loads the stack even when the server sends no STEP event', async () => {
  const pause = deferred(), { session } = await fixture({ pauseRun: () => pause.promise });
  await session.start(profile);
  const pausing = session.control('pauseRun');
  assert.equal(session.state, 'running'); assert.equal(session.pending, true);
  pause.resolve(null); await pausing; await tick();
  assert.equal(session.reason, '手动暂停'); assert.equal(session.paused, true);
  assert.equal(session.frame.stackFrameId, 0); assert.equal(session.variables[0].name, 't');
  await session.stop();
});

test('breakpoints changed or cleared during startup are applied before executing', async () => {
  for (const lines of [[2], []]) {
    const sent = deferred(), reply = deferred(); let requests = 0;
    const { session, calls } = await fixture({ setBreaks: async args => {
      if (++requests === 1) { sent.resolve(); await reply.promise; }
      return [args[0], args[1]];
    } });
    await session.setBreakpoints('one.dos', [1]);
    const starting = session.start(profile); await sent.promise;
    await session.setBreakpoints('one.dos', lines);
    assert.equal(calls.some(([func]) => func === 'runScriptWithDebug'), false);
    reply.resolve(); await starting;
    const applied = calls.filter(([func]) => func === 'setBreaks');
    assert.deepEqual(Array.from(applied.at(-1)[1][1]), lines);
    assert.equal(session.breaks.get('one.dos').every(point => point.verified), true);
    assert.equal(calls.at(-1)[0], 'runScriptWithDebug');
    await session.stop();
  }
});

test('startup also flushes configuration edits made while the exception RPC is pending', async () => {
  const sent = deferred(), reply = deferred(); let requests = 0;
  const { session, calls } = await fixture({ setAllExceptionBreak: async () => {
    if (++requests === 1) { sent.resolve(); await reply.promise; }
  } });
  await session.setBreakpoints('one.dos', [1]);
  const starting = session.start(profile); await sent.promise;
  await session.setBreakpoints('one.dos', []); await session.setExceptions(true);
  reply.resolve(); await starting;
  assert.deepEqual(Array.from(calls.filter(([func]) => func === 'setBreaks').at(-1)[1][1]), []);
  assert.equal(calls.filter(([func]) => func === 'setAllExceptionBreak').at(-1)[1][0], true);
  assert.equal(calls.at(-1)[0], 'runScriptWithDebug');
  await session.stop();
});

test('stopping while connection credentials are pending cannot start a late debug session', async () => {
  const ticket = deferred(), { session, calls, locks } = await fixture({ ticket: () => ticket.promise });
  const starting = session.start(profile); await session.stop(); ticket.resolve({ path: 'ticket', password: 'secret' }); await starting;
  assert.equal(session.state, 'ended'); assert.equal(calls.length, 0); assert.deepEqual(locks, [true, false]);
});

test('late stack/variable responses cannot repopulate a resumed or stopped session', async () => {
  const variables = deferred(); const { session, event } = await fixture({ getStackVariables: () => variables.promise });
  await session.start(profile); event({ event: 'STEP', message: 'OK', data: { line: 1 } }); await tick();
  assert.equal(session.paused, true); await session.control('continueRun'); variables.resolve([{ name: 'stale' }]); await tick();
  assert.equal(session.variables.length, 0); assert.equal(session.frame, null);
  await session.stop(); event({ event: 'BREAKPOINT', message: 'OK', data: { line: 1 } });
  // In production the remote callbacks are epoch guarded by start().
  assert.equal(session.state, 'ended');
});

test('syntax errors release editing and exception events preserve the error location', async () => {
  const { session, event, locks } = await fixture({ stackTrace: async () => [] });
  await session.start(profile); event({ event: 'ERROR', message: 'division by zero', data: { line: 1, moduleName: '' } }); await tick();
  assert.equal(session.frame.line, 1); assert.equal(session.frame.stackFrameId, -1); assert.match(session.error, /division/);
  await session.stop(); await session.start(profile);
  event({ event: 'SYNTAX', message: 'bad syntax' }); assert.equal(session.active, false); assert.equal(locks.at(-1), false);
});

test('imported module source paths and breakpoints survive restarting the same DOS debugger', async () => {
  const { session, calls, event } = await fixture({ parseScriptWithDebug: async () => ({ modules: { 'qa::math': '/server/modules/qa/math.dos' } }),
    sourceRequest: async name => { assert.equal(name, 'qa::math'); return 'module qa::math\ndef plus(x){return x+1}'; },
    stackTrace: async () => [{ stackFrameId: 3, line: 1, moduleName: 'qa::math' }] });
  await session.start(profile);
  const path = session.sourcePath('qa::math'); assert.match(path, /qa\/math\.dos$/);
  assert.match(await session.source(path), /module qa::math/);
  await session.setBreakpoints(path, [1]);
  event({ event: 'STEP', message: 'OK', data: { line: 1, moduleName: 'qa::math' } }); await tick();
  assert.equal(session.sourcePath(session.frame.moduleName), path);
  await session.stop(); await session.start(profile);
  assert(calls.filter(([f,args]) => f === 'setBreaks' && args[0] === 'qa::math' && args[1][0] === 1).length >= 2);
  await session.stop();
});

test('a late stop acknowledgement cannot terminate a replacement debug connection', async () => {
  const stop = deferred(), { session, event } = await fixture({ stopRun: () => stop.promise });
  await session.start(profile); const stopping = session.stop();
  event({ event: 'END', message: 'OK', data: { status: 'STOPPED' } });
  await session.start(profile); stop.resolve(null); await stopping;
  assert.equal(session.state, 'running'); await session.stop();
});

test('real DolphinDB debugger: break, step into/out, variables, continue and stop', { skip: !process.env.DDB_DEBUG_TEST_HOST }, async () => {
  const sdk = await import('dolphindb/browser.js'), load = dataLoader(sdk), WS = require('ws');
  const sockets = [];
  const { DebugRemote } = load('debugger/remote'), { DosDebugSession } = load('debugger/session');
  const host = { source: () => 'def bump(x){\n y=x+1\n return y\n}\na=1\nb=bump(a)\nt=table(1..4 as id)\nprint(b)',
    ticket: async () => ({ path: `ws://${process.env.DDB_DEBUG_TEST_HOST}:${process.env.DDB_TEST_PORT || 8848}/`, username: process.env.DDB_TEST_USER || '', password: process.env.DDB_TEST_PASSWORD || '', timeout: 10 }),
    url: path => path, locked: () => {} };
  const session = new DosDebugSession('debug.dos', host, (url, timeout, event, closed) => new DebugRemote(url, timeout, event, closed, url => { const socket = new WS(url, ['debug']); sockets.push(socket); return socket; }));
  const wait = async predicate => { const until = Date.now() + 10000; while (!predicate()) { if (Date.now() > until) { throw new Error(`Timed out: ${session.state}, ${session.error}`); } await tick(); } };
  try {
    await session.setBreakpoints('debug.dos', [5, 7]); await session.start(profile);
    await wait(() => session.paused && session.variables.some(v => v.name === 'a'));
    assert.equal(session.frame.line, 5); assert.equal(session.variables.find(v => v.name === 'a').ddbValue.value, 1);
    await session.control('stepInto'); await wait(() => session.paused && session.frame?.line === 1 && session.variables.some(v => v.name === 'x'));
    assert.equal(session.variables.find(v => v.name === 'x').ddbValue.value, 1);
    await session.control('stepOver'); await wait(() => session.paused && session.variables.some(v => v.name === 'y'));
    assert.equal(session.variables.find(v => v.name === 'y').ddbValue.value, 2);
    await session.control('stepOut'); await wait(() => session.paused && session.frame?.line >= 5);
    await session.control('continueRun'); await wait(() => session.paused && session.frame?.line === 7 && session.variables.some(v => v.name === 't'));
    const table = await session.value(session.variables.find(v => v.name === 't')); assert.equal(table.rows, 4);
    await session.control('continueRun'); await wait(() => session.state === 'ended'); assert.match(session.output, /2/);
    await session.start(profile); await wait(() => session.paused); await session.stop(); assert.equal(session.active, false);
    await session.setBreakpoints('debug.dos', []);
    host.source = () => 'for(i in 1..1000){\n sleep(10)\n}\nprint(i)';
    await session.start(profile); await session.control('pauseRun'); await wait(() => session.paused && session.frame);
    await session.stop(); assert.equal(session.reason, '已停止');
    host.source = () => 'a=1\nthrow "qa_debug_error"\nb=2';
    await session.setExceptions(true); await session.start(profile);
    await wait(() => session.paused && session.error.includes('qa_debug_error')); await session.stop();
  } finally { await session.stop(); for (const socket of sockets) { socket.terminate(); } }
});
