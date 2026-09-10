import { LanguageSupport, StreamLanguage } from '@codemirror/language';
import { hoverTooltip } from '@codemirror/view';
import type { ICompletionProvider, ICompletionContext, CompletionHandler } from '@jupyterlab/completer';
import { DocsProvider } from 'dolphindb/docs.js';
import { keywords, constants } from 'dolphindb/language.js';
import type { DosManager } from './model';
import { tableColumns } from './runtime';

export const DOS_MIME = 'text/x-dolphindb';
const keywordSet = new Set(keywords), constantSet = new Set<string>(constants);
let provider: Promise<DocsProvider> | undefined;
export function documentation(): Promise<DocsProvider> {
  return provider ??= import('dolphindb/docs.zh.json').then(module => new DocsProvider(module.default));
}

/** CodeMirror host adapter using the same keyword/constants and DocsProvider as VS Code. */
export function languageSupport(): LanguageSupport {
  const language = StreamLanguage.define<{ comment: boolean; quote: string }>({
    name: 'dolphindb',
    startState: () => ({ comment: false, quote: '' }),
    token(stream, state) {
      if (state.comment) {
        if (stream.match(/.*?\*\//)) { state.comment = false; } else { stream.skipToEnd(); }
        return 'comment';
      }
      if (state.quote) {
        while (!stream.eol()) {
          const next = stream.next();
          if (next === '\\') { stream.next(); }
          else if (next === state.quote) { state.quote = ''; break; }
        }
        return 'string';
      }
      if (stream.eatSpace()) { return null; }
      if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
      if (stream.match('/*')) { state.comment = true; return 'comment'; }
      if (stream.match(/["']/)) { state.quote = stream.current(); return 'string'; }
      if (stream.match(/`[\w\u4e00-\u9fff]*/)) { return 'string'; }
      if (stream.match(/(?:\d+(?:\.\d+)*(?:[eE][+-]?\d+)?[a-zA-Z]*|\.\d+)/)) { return 'number'; }
      if (stream.match(/[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*!?/)) {
        const word = stream.current();
        return keywordSet.has(word) ? 'keyword' : constantSet.has(word) ? 'atom'
          : stream.match(/^\s*\(/, false) ? 'variableName.function' : 'variableName';
      }
      if (stream.match(/[+\-*\/=%<>!&|^~?:]+/)) { return 'operator'; }
      stream.next();
      return 'punctuation';
    },
    languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } }, closeBrackets: { brackets: ['(', '[', '{', '"', "'"] } },
  });
  const hover = hoverTooltip(async (view, position) => {
    const line = view.state.doc.lineAt(position);
    const local = position - line.from;
    const match = [...line.text.matchAll(/[A-Za-z_]\w*!?/g)].find(m => m.index! <= local && m.index! + m[0].length >= local);
    if (!match) { return null; }
    const docs = await documentation();
    const signatures = docs.get_signatures(match[0]);
    const markdown = docs.get_function_markdown(match[0]);
    if (!markdown) { return null; }
    return { pos: line.from + match.index!, end: line.from + match.index! + match[0].length, above: true, create: () => {
      const dom = document.createElement('div');
      dom.className = 'ddb-function-help';
      const signature = document.createElement('strong');
      signature.textContent = signatures?.map(s => s.full).join('\n') ?? match[0];
      const content = document.createElement('pre');
      content.textContent = markdown.slice(0, 1600);
      dom.append(signature, content);
      return { dom };
    } };
  });
  return new LanguageSupport(language, [hover]);
}

function pathFrom(context: ICompletionContext): string | undefined {
  return (context.widget as { context?: { path: string } }).context?.path;
}

export function completionProvider(manager: DosManager): ICompletionProvider {
  return {
    identifier: 'dolphindb-extension:completion', rank: 1200,
    isApplicable: async context => Boolean(pathFrom(context)?.toLowerCase().endsWith('.dos')),
    async fetch(request, context) {
      const before = request.text.slice(0, request.offset);
      const word = before.match(/[A-Za-z_]\w*!?$/)?.[0] ?? '';
      const start = request.offset - word.length;
      const docs = await documentation();
      const { keywords, constants, functions } = docs.complete(word);
      const starts = functions.filter(name => name.toLowerCase().startsWith(word.toLowerCase()));
      const model = manager.document(pathFrom(context)!);
      const entries: CompletionHandler.ICompletionItem[] = [
        ...model.variables.map(v => ({ label: v.name, type: v.form === 'TABLE' ? 'instance' : 'variable', documentation: `${v.type} · ${v.rows} × ${v.columns}${v.value ? `\n${v.value}` : ''}` })),
        ...[...request.text.matchAll(/\b([A-Za-z_]\w*)\s*=(?!=)/g)].map(m => ({ label: m[1], type: 'variable' })),
        ...[...request.text.matchAll(/\bdef\s+([A-Za-z_]\w*!?)\s*\(/g)].map(m => ({ label: m[1], type: 'function' })),
        ...model.databases.flatMap(db => db.tables.map(table => ({ label: table, type: 'instance', documentation: db.path }))),
      ];
      const table = before.match(/([A-Za-z_]\w*)\.[A-Za-z_]*$/)?.[1]
        ?? request.text.match(/\bfrom\s+([A-Za-z_]\w*)/i)?.[1];
      if (table && model.connection?.ddb.connected && !model.executing && model.variables.some(v => v.name === table && v.form === 'TABLE')) {
        try { entries.unshift(...(await tableColumns(model.connection.ddb, table)).map(label => ({ label, type: 'property' }))); } catch { /* Metadata permissions do not prevent local completions. */ }
      }
      const local = entries.filter(e => e.label.toLowerCase().startsWith(word.toLowerCase()));
      const all = [...local, ...keywords.map(label => ({ label, type: 'keyword' })), ...constants.map(label => ({ label, type: 'constant' })), ...(starts.length ? starts : functions).map(label => ({ label, type: 'function' }))];
      const seen = new Set<string>();
      return { start, end: request.offset, items: all.filter(item => !seen.has(item.label) && Boolean(seen.add(item.label))).slice(0, 250) };
    },
    async resolve(item) {
      const docs = await documentation();
      return { ...item, documentation: item.documentation ?? docs.get_function_markdown(item.label) };
    },
  };
}
