const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

exports.dataLoader = sdk => {
  const cache = new Map();
  const root = path.resolve(__dirname, '../../frontend');
  const load = name => {
    let file = path.isAbsolute(name) ? name : path.resolve(root, name);
    if (!existsSync(file)) { file += existsSync(file + '.ts') ? '.ts' : '.tsx'; }
    if (cache.has(file)) { return cache.get(file).exports; }
    const module = { exports: {} }; cache.set(file, module);
    const requireModule = id => id === 'dolphindb/browser.js' ? sdk : id.startsWith('.') ? load(path.resolve(path.dirname(file), id)) : require(id);
    vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
    } }).outputText, { module, exports: module.exports, require: requireModule, console,
      TextDecoder, TextEncoder, Uint8Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array, BigInt64Array, DataView,
      crypto: globalThis.crypto, setTimeout, clearTimeout }, { filename: file });
    return module.exports;
  };
  return load;
};
