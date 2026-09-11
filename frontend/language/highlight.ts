import { LanguageSupport, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { Tag, tagHighlighter } from '@lezer/highlight';
import { INITIAL, Registry, parseRawGrammar, type IGrammar, type IOnigLib, type IToken, type StateStack } from 'vscode-textmate';
import { tm_language } from 'dolphindb/language.js';

// Unique tags keep Jupyter's generic keyword bold/comment italic rules from overriding it.
const categories = ['plain', 'keyword', 'constant', 'number', 'string', 'escape', 'comment', 'function', 'variable', 'operator', 'invalid'] as const;
type Category = typeof categories[number];
// Prefix token names too: StreamLanguage reserves legacy names such as "variable".
const tokenTable = Object.fromEntries(categories.map(category => [`ddb-${category}`, Tag.define()]));
export const tokenClasses = tagHighlighter(categories.map(category => ({ tag: tokenTable[`ddb-${category}`], class: `ddb-token-${category}` })));

function tokenCategory(scopes: readonly string[]): Category {
  for (let index = scopes.length - 1; index >= 0; index--) {
    const scope = scopes[index];
    if (scope.startsWith('invalid.')) { return 'invalid'; }
    if (scope.startsWith('comment.')) { return 'comment'; }
    if (scope.startsWith('constant.character.escape.')) { return 'escape'; }
    if (scope.startsWith('string.')) { return 'string'; }
    if (scope.startsWith('constant.numeric.')) { return 'number'; }
    if (scope.startsWith('constant.language.') || scope.startsWith('punctuation.section.embedded.')) { return 'constant'; }
    if (scope.startsWith('entity.name.function.')) { return 'function'; }
    if (scope.startsWith('variable.')) { return 'variable'; }
    if (scope.startsWith('keyword.operator.')) { return 'operator'; }
    if (scope.startsWith('keyword.')) { return 'keyword'; }
  }
  return 'plain';
}

export async function createDdbGrammar(onigLib: IOnigLib): Promise<IGrammar> {
  const registry = new Registry({ onigLib: Promise.resolve(onigLib),
    loadGrammar: async scope => scope === 'source.dolphindb'
      ? parseRawGrammar(JSON.stringify(tm_language), 'dolphindb.tmLanguage.json') : null });
  const grammar = await registry.loadGrammar('source.dolphindb');
  if (!grammar) { throw new Error('无法加载 DolphinDB 语法。'); }
  return grammar;
}

interface State { stack: StateStack; tokens: IToken[]; index: number }

/** CodeMirror owns incremental parsing; TextMate owns lexical rules and multiline state. */
export function createDdbLanguage(grammar: IGrammar): LanguageSupport {
  const language = StreamLanguage.define<State>({
    name: 'dolphindb', tokenTable,
    startState: () => ({ stack: INITIAL, tokens: [], index: 0 }),
    copyState: state => ({ ...state }), // TextMate stacks and token arrays are immutable here.
    blankLine(state) { state.stack = grammar.tokenizeLine('', state.stack).ruleStack; },
    token(stream, state) {
      if (stream.sol()) {
        const line = grammar.tokenizeLine(stream.string, state.stack);
        state.stack = line.ruleStack; state.tokens = line.tokens; state.index = 0;
      }
      const token = state.tokens[state.index++];
      if (!token) { stream.skipToEnd(); return 'ddb-plain'; }
      stream.pos = Math.min(token.endIndex, stream.string.length);
      return `ddb-${tokenCategory(token.scopes)}`;
    },
    languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } }, closeBrackets: { brackets: ['(', '[', '{', '"', "'"] } },
  });
  return new LanguageSupport(language, syntaxHighlighting(tokenClasses));
}
