import type { LanguageSupport } from '@codemirror/language';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { createDdbGrammar, createDdbLanguage } from '../language/highlight';

export const DOS_MIME = 'text/x-dolphindb';
let support: Promise<LanguageSupport> | undefined;

/** Bundle the same TextMate/Oniguruma runtime used by VS Code, including its WASM. */
export function languageSupport(): Promise<LanguageSupport> {
  return support ??= (async () => {
    const response = await fetch(new URL('vscode-oniguruma/release/onig.wasm', import.meta.url));
    if (!response.ok) { throw new Error('无法加载 DolphinDB 高亮引擎。'); }
    await loadWASM(await response.arrayBuffer());
    return createDdbLanguage(await createDdbGrammar({ createOnigScanner, createOnigString }));
  })();
}
