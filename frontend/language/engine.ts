import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItemKind, type CompletionItem, type Diagnostic, type Hover, type Location } from 'vscode-languageserver-types';
import { DocsProvider } from 'dolphindb/docs.js';
import { SymbolService, documentSymbols } from '../upstream/language/symbols';
import { createCompletions } from '../upstream/language/completions';
import { createDefinitions } from '../upstream/language/definitions';
import { createDiagnostics } from '../upstream/language/diagnostics';
import type { LanguageBinding, LanguageHost, Projection, Suggestions } from './contracts';
import { MetadataDatabase } from './metadata';
import type { ModuleIndex } from './modules';
import { openLiteral } from './regions';

const docs = new Map<string, Promise<DocsProvider>>();
export function documentation(language = 'zh'): Promise<DocsProvider> {
  let loaded = docs.get(language);
  if (!loaded) {
    loaded = (language === 'en' ? import('dolphindb/docs.en.json') : import('dolphindb/docs.zh.json'))
      .then(module => new DocsProvider(module.default));
    docs.set(language, loaded);
  }
  return loaded;
}

export class LanguageEngine {
  constructor(readonly modules: ModuleIndex, readonly preferences: () => { moduleRoot: string; documentationLanguage: string }) {}
  private metadata = new WeakMap<LanguageBinding, { identity: unknown; expires: number; data: Promise<MetadataDatabase> }>();
  private async context(binding: LanguageBinding, projection: Projection, live: boolean) {
    const path = binding.path(), settings = this.preferences();
    const root = settings.moduleRoot || path.slice(0, Math.max(0, path.lastIndexOf('/')));
    const modules = await this.modules.list(root);
    const symbolService = new SymbolService(async file => modules.find(m => m.filePath === file)?.source ?? '');
    for (const module of modules) {
      const symbols = this.modules.symbols.symbols.get(module.filePath);
      if (symbols) { symbolService.symbols.set(module.filePath, symbols); }
    }
    const document = TextDocument.create(path, 'dolphindb', 0, projection.source);
    symbolService.buildSymbolByDocument(document);
    let dbService = new MetadataDatabase(binding.metadata);
    if (live) {
      let entry = this.metadata.get(binding);
      if (!entry || entry.identity !== binding.identity() || Date.now() > entry.expires) {
        entry = { identity: binding.identity(), expires: Date.now() + 1500, data: dbService.refresh().then(() => dbService) };
        this.metadata.set(binding, entry);
      }
      dbService = await entry.data;
    }
    const host: LanguageHost = {
      documents: new Map([[path, document]]), symbolService, dbService,
      ddbModules: { getModules: () => modules, getIsInitModuleIndex: () => true },
    };
    return { host, document, position: { textDocument: { uri: path }, position: document.positionAt(projection.offset) } };
  }
  async complete(binding: LanguageBinding, projection: Projection): Promise<Suggestions> {
    const before = projection.source.slice(0, projection.offset);
    const after = projection.source.slice(projection.offset, projection.base + projection.region.to);
    const word = before.match(/[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*!?$/)?.[0] ?? '';
    const suffix = after.match(/^[\w\u4e00-\u9fff]*!?/)?.[0] ?? '';
    const empty: Suggestions = { from: projection.offset - projection.base - word.length, to: projection.offset - projection.base + suffix.length, items: [] };
    if (/^\s*\/\//.test(before.slice(before.lastIndexOf('\n') + 1))) { return empty; }
    const { host, position } = await this.context(binding, projection, true);
    const upstream = await createCompletions(host).complete(position);
    const priority = upstream.some(v => 'order' in v && v.order !== undefined);
    const literal = openLiteral(before);
    const member = !literal && /(?<!\.)\.[\w\u4e00-\u9fff]*!?$/.test(before);
    let items: CompletionItem[] = upstream;
    if (!priority && member) {
      // A dot is handled by the upstream context provider, not by the global docs provider.
      // Missing runtime metadata must not turn an empty member prefix into the whole API catalog.
      const table = before.match(/(?<![\w\u4e00-\u9fff.:])([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*)\.[\w\u4e00-\u9fff]*!?$/)?.[1];
      const columns = table ? await host.dbService.getColnames(table) : [];
      if (columns.length) { items = columns.map(label => ({ label, kind: CompletionItemKind.Field })); }
    } else if (!priority) {
      const provider = await documentation(this.preferences().documentationLanguage);
      const builtins = provider.complete(word);
      const runtime = host.dbService.variables.map(v => ({ label: v.name, kind: v.form === 'TABLE' ? CompletionItemKind.Struct : CompletionItemKind.Variable, detail: `${v.type} · ${v.form}` }));
      items = [...upstream, ...runtime,
        ...builtins.keywords.map(label => ({ label, kind: CompletionItemKind.Keyword })),
        ...builtins.constants.map(label => ({ label, kind: CompletionItemKind.Constant })),
        ...builtins.functions.map(label => ({ label, kind: CompletionItemKind.Function })),
      ];
    }
    if (literal && priority) {
      empty.from = literal.from - projection.base;
      let length = 0;
      while (length < after.length && after[length] !== literal.quote && !/[\r\n]/.test(after[length])) {
        if (literal.quote === '`' && !/[\w\u4e00-\u9fff]/.test(after[length])) { break; }
        if (after[length] === '\\') { length++; }
        length++;
      }
      empty.to = projection.offset - projection.base + Math.min(length, after.length);
      const unquote = (value: string) => value.replace(/^["'`]|["']$/g, '');
      items = items.map(item => item.kind === CompletionItemKind.Value ? { ...item, label: unquote(item.label), insertText: unquote(item.insertText ?? item.label) } : item);
    }
    const unique = new Set<string>();
    return { ...empty, items: items.filter(item => {
      const key = `${item.label}\0${item.insertText ?? item.label}`;
      if (unique.has(key)) { return false; } unique.add(key); return true;
    }) };
  }
  async hover(binding: LanguageBinding, projection: Projection): Promise<Hover | null> {
    const { host, position } = await this.context(binding, projection, false);
    return createDefinitions(host).hover(position);
  }
  async definitions(binding: LanguageBinding, projection: Projection): Promise<Location[]> {
    const { host, position } = await this.context(binding, projection, false);
    const found = await createDefinitions(host).definition(position);
    if (found?.length) { return found; }
    const imported = projection.source.split('\n')[position.position.line]?.trim().match(/^use\s+([\w:]+)\s*;?$/)?.[1];
    const module = host.ddbModules.getModules().find(m => m.moduleName === imported);
    return module ? [{ uri: module.filePath, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] : [];
  }
  async diagnostics(binding: LanguageBinding, projection: Projection): Promise<Diagnostic[]> {
    const { host, document } = await this.context(binding, projection, false);
    return createDiagnostics(host)(document);
  }
  async outline(binding: LanguageBinding, projection: Projection) {
    const { host } = await this.context(binding, projection, false);
    return documentSymbols(host.symbolService, binding.path());
  }
}
