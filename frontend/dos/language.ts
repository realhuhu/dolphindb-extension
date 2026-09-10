import { LanguageSupport, StreamLanguage } from '@codemirror/language';
import { keywords, constants } from 'dolphindb/language.js';

export const DOS_MIME = 'text/x-dolphindb';
const keywordSet = new Set(keywords), constantSet = new Set<string>(constants);
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
  return new LanguageSupport(language);
}
