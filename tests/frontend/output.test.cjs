const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const sandbox = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(resolve(__dirname, '../../frontend/dos/output-model.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
const { OutputAdapter, resultData, TABLE_MIME } = sandbox.exports;
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const outputs = [];
  let changes = 0;
  const model = {
    get length() { return outputs.length; },
    clear() { outputs.length = 0; changes++; },
    add(value) {
      // OutputAreaModel consolidates adjacent stdout chunks into one record.
      const last = outputs.at(-1);
      if (last?.output_type === 'stream' && value.output_type === 'stream' && last.name === value.name) {
        last.text += value.text;
      } else { outputs.push(plain(value)); }
      changes++; return outputs.length;
    },
    set(index, value) { outputs[index] = plain(value); changes++; },
  };
  return { outputs, adapter: new OutputAdapter(model), changes: () => changes };
}

test('stream updates append only new text and unrelated model refreshes do not recreate output', () => {
  const f = fixture(), entry = { id: '1', prints: ['first'], status: 'running' };
  f.adapter.update(entry);
  entry.prints.push('second'); f.adapter.update(entry);
  assert.equal(f.outputs.length, 1); assert.equal(f.outputs[0].text, 'first\nsecond\n');
  const changes = f.changes(); f.adapter.update({ ...entry, status: 'ok', elapsed: 20 });
  assert.equal(f.changes(), changes);
  entry.value = { text: 'done' }; f.adapter.update(entry);
  assert.equal(f.outputs.length, 2);
  assert.deepEqual(f.outputs[1], { output_type: 'display_data', data: { 'text/plain': 'done' }, metadata: {} });
});

test('a final error replaces the result without dropping consolidated stdout', () => {
  const f = fixture(), entry = { id: '1', prints: ['a', 'b'], value: { text: 'partial' } };
  f.adapter.update(entry);
  entry.error = 'Syntax error\nline 2'; f.adapter.update(entry);
  assert.equal(f.outputs.length, 2); assert.equal(f.outputs[0].text, 'a\nb\n');
  assert.deepEqual(f.outputs[1], { output_type: 'error', ename: 'DolphinDBError', evalue: entry.error, traceback: ['Syntax error', 'line 2'] });
});

test('history replacement and late stream records preserve execution order without duplicates', () => {
  const f = fixture(), entry = { id: '1', prints: ['first'], value: { text: 'done' } };
  f.adapter.update(entry); entry.prints.push('late'); f.adapter.update(entry);
  assert.equal(f.outputs.length, 2); assert.equal(f.outputs[0].text, 'first\nlate\n');
  assert.equal(f.outputs[1].data['text/plain'], 'done');
  f.adapter.update({ id: '2', prints: [] }); assert.equal(f.outputs.length, 0);
  f.adapter.update(entry); entry.prints = []; f.adapter.update(entry);
  assert.equal(f.outputs.length, 1); assert.equal(f.outputs[0].data['text/plain'], 'done');
});

test('table snapshots keep typed cells and row counts without promoting markup to HTML', () => {
  const table = { columns: ['id', 'value'], rows: [['2', '<script>alert(1)</script>'], ['1', 'A&B']], totalRows: 500, sortRanks: [[1, 0], [0, 1]] };
  const data = plain(resultData(table));
  assert.deepEqual(data[TABLE_MIME], table);
  assert.equal(data['text/plain'], 'id\tvalue\n2\t<script>alert(1)</script>\n1\tA&B');
  assert.equal(data['text/html'], undefined);
  assert.deepEqual(plain(resultData({ text: '<b>literal</b>' })), { 'text/plain': '<b>literal</b>' });
});

test('table ordering uses original SDK doubles, integers and decimals before display formatting', async () => {
  const sdk = await import('dolphindb/browser.js');
  const { DdbObj, DdbForm, DdbType, BigInt128Array, nulls } = sdk;
  const module = { exports: {}, require: id => { assert.equal(id, 'dolphindb/browser.js'); return sdk; } };
  vm.runInNewContext(ts.transpileModule(readFileSync(resolve(__dirname, '../../frontend/dos/table.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, module);
  const ranks = (type, value, rows) => plain(module.exports.columnSortRanks(new DdbObj({ form: DdbForm.vector, type, value, rows }), rows));
  assert.deepEqual(ranks(DdbType.double, Float64Array.of(-2, -10, 2.1, 2.02, nulls.double), 5), [1, 0, 3, 2, 4]);
  assert.deepEqual(ranks(DdbType.long, BigInt64Array.of(9007199254740993n, 9007199254740992n, -10n), 3), [2, 1, 0]);
  assert.deepEqual(ranks(DdbType.decimal128, { scale: 2, data: BigInt128Array.of(-200n, -1000n, 210n, 202n, nulls.int128) }, 5), [1, 0, 3, 2, 4]);
  assert.deepEqual(ranks(DdbType.double, Float64Array.of(2, 2, -1), 3), [1, 1, 0]);
  assert.deepEqual(ranks(DdbType.string, ['2', '10', '01', '11'], 4), [3, 1, 0, 2]);
});
