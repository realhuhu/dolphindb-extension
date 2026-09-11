import { autocompletion, completionKeymap, acceptCompletion, startCompletion, snippet, insertCompletionText, pickedCompletion, nextSnippetField, prevSnippetField, hasNextSnippetField, hasPrevSnippetField, type Completion, type CompletionContext } from '@codemirror/autocomplete';
import { StateEffect, StateField, Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, Decoration, hoverTooltip, closeHoverTooltips, keymap, showTooltip, type DecorationSet, type Tooltip } from '@codemirror/view';
import { linter, forceLinting } from '@codemirror/lint';
import { highlightTree } from '@lezer/highlight';
import type { LanguageSupport } from '@codemirror/language';
import type { CodeEditor } from '@jupyterlab/codeeditor';
import { MimeModel, type IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItemKind, InsertTextFormat, type CompletionItem } from 'vscode-languageserver-types';
import type { SettingsModel } from '../settings';
import { tokenClasses } from './highlight';
import { ddbRegions } from './regions';
import { documentation, type LanguageEngine } from './engine';
import type { LanguageBinding, Projection } from './contracts';

const signatureEffect = StateEffect.define<Tooltip | null>();
const bindingEffect = StateEffect.define<null>();
const signatureField = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged || transaction.selection) { value = null; }
    for (const effect of transaction.effects) { if (effect.is(signatureEffect)) { value = effect.value; } }
    return value;
  },
  provide: field => showTooltip.from(field),
});
const kindNames: Record<number, string> = {
  [CompletionItemKind.Function]: 'function', [CompletionItemKind.Variable]: 'variable',
  [CompletionItemKind.Field]: 'property', [CompletionItemKind.Keyword]: 'keyword',
  [CompletionItemKind.Constant]: 'constant', [CompletionItemKind.Module]: 'namespace', [CompletionItemKind.Snippet]: 'text',
};
const markdownText = (content: CompletionItem['documentation']): string => typeof content === 'string' ? content : content?.value ?? '';

/** Standard CodeMirror extensions, registered through Jupyter's editor extension registry. */
export class LanguageEditors {
  private bindings = new WeakMap<CodeEditor.IModel, Set<{ binding: LanguageBinding; host?: () => HTMLElement | undefined }>>();
  private views = new WeakMap<CodeEditor.IModel, Set<EditorView>>();
  active: { model: CodeEditor.IModel; view: EditorView } | null = null;
  constructor(readonly engine: LanguageEngine, readonly settings: SettingsModel, private rendermime: IRenderMimeRegistry, private language: LanguageSupport) {}
  bind(model: CodeEditor.IModel, binding: LanguageBinding, host?: () => HTMLElement | undefined): () => void {
    const entries = this.bindings.get(model) ?? new Set(), entry = { binding, host };
    entries.add(entry); this.bindings.set(model, entries);
    if (binding.path().toLowerCase().endsWith('.dos')) { this.engine.modules.open.set(entry, binding); }
    this.refreshBinding(model);
    return () => {
      if (entries.delete(entry)) {
        if (!entries.size) { this.bindings.delete(model); }
        this.engine.modules.open.delete(entry); this.refreshBinding(model);
      }
    };
  }
  private refreshBinding(model: CodeEditor.IModel) {
    // Notebook cells can be bound after their editor is created. Defer to avoid
    // dispatching during a shared-model/editor update, including on unbind.
    queueMicrotask(() => {
      for (const view of this.views.get(model) ?? []) { view.dispatch({ effects: bindingEffect.of(null) }); }
    });
  }
  private viewFor(model: CodeEditor.IModel): EditorView | undefined {
    const views = this.views.get(model);
    return [...views ?? []].find(view => view.hasFocus)
      ?? (this.active?.model === model && views?.has(this.active.view) ? this.active.view : views?.values().next().value);
  }
  private bindingFor(model: CodeEditor.IModel, view = this.viewFor(model)): LanguageBinding | undefined {
    // Cloned notebooks share cell models. Resolve callbacks against the editor
    // that initiated the request, including editors recreated by windowing.
    return [...this.bindings.get(model) ?? []].find(entry => !entry.host || view && entry.host()?.contains(view.dom))?.binding;
  }
  private current(model: CodeEditor.IModel, source: string, offset: number, view?: EditorView) {
    const binding = this.bindingFor(model, view);
    const projection = binding?.project(source, offset);
    return binding && projection ? { binding, projection } : null;
  }
  complete(model: CodeEditor.IModel): boolean { const view = this.viewFor(model); return view ? startCompletion(view) : false; }
  async jump(view: EditorView, model: CodeEditor.IModel): Promise<void> {
    const current = this.current(model, view.state.doc.toString(), view.state.selection.main.head, view);
    if (!current) { return; }
    const locations = await this.engine.definitions(current.binding, current.projection);
    if (locations.length) { await current.binding.open(locations[0].uri, locations[0].range); }
  }
  async symbols() {
    const active = this.active;
    if (!active) { return null; }
    const source = active.view.state.doc.toString();
    const region = ddbRegions(source, active.model.mimeType === 'text/x-dolphindb' && !/^%%ddb\b/.test(source))[0];
    const current = region && this.current(active.model, source, region.from, active.view);
    return current ? { binding: current.binding, items: await this.engine.outline(current.binding, current.projection) } : null;
  }
  private renderMarkdown(markdown: string) {
    const renderer = this.rendermime.createRenderer('text/markdown');
    renderer.node.classList.add('ddb-language-help');
    void renderer.renderModel(new MimeModel({ data: { 'text/markdown': markdown }, trusted: false }));
    return { dom: renderer.node, destroy: () => renderer.dispose() };
  }
  private item(item: CompletionItem, projection: Projection): Completion {
    return {
      label: item.label, detail: item.detail, type: kindNames[item.kind ?? 0] ?? 'text',
      boost: item.kind === CompletionItemKind.Field ? 50 : 'order' in item ? 30 : 0,
      info: async () => {
        const docs = await documentation(this.settings.value.language.documentationLanguage);
        const markdown = markdownText(item.documentation) || docs.get_function_markdown(item.label);
        return markdown ? this.renderMarkdown(markdown) : null;
      },
      apply: (view, completion, from, to) => {
        let text = item.insertText ?? item.label;
        const qualified = view.state.sliceDoc(0, from).match(/[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*::$/)?.[0];
        if (qualified && text.startsWith(qualified)) { from -= qualified.length; }
        // Upstream requests module imports; map these edits into the active DDB region.
        const imports = (item.additionalTextEdits ?? []).map(edit => edit.newText).filter(value => /^use [\w:]+\n$/.test(value));
        if (imports.length) {
          const { region } = projection;
          let at = region.kind === 'file' ? (/^module\s/.test(view.state.doc.toString()) ? view.state.doc.line(1).to + 1 : 0) : region.from;
          let insert = imports.join('');
          if (region.kind === 'line') {
            at = region.header;
            const indent = view.state.doc.lineAt(at).text.match(/^\s*/)?.[0] ?? '';
            insert = imports.map(value => `${indent}%ddb ${value}`).join('');
          }
          view.dispatch({ changes: { from: at, insert } });
          if (at <= from) { from += insert.length; to += insert.length; }
        }
        if (item.insertTextFormat === InsertTextFormat.Snippet) {
          text = text.replace(/\$\{(\d+)\}/g, (_match, index) => '${' + index + ':}');
          if (!/\$\{0(?::|\})/.test(text)) { text += '${0:}'; }
          snippet(text)(view, completion, from, to);
        } else {
          view.dispatch({ ...insertCompletionText(view.state, text, from, to), annotations: pickedCompletion.of(completion) });
        }
      },
    };
  }
  extension(model: CodeEditor.IModel): Extension {
    const owner = this;
    const start = (view: EditorView): boolean => owner.current(model, view.state.doc.toString(), view.state.selection.main.head, view)
      ? startCompletion(view) : owner.bindingFor(model, view)?.nativeComplete?.() ?? false;
    const source = async (context: CompletionContext) => {
      const current = owner.current(model, context.state.doc.toString(), context.pos, context.view);
      if (!current || !context.explicit && !owner.settings.value.language.automaticCompletion) { return null; }
      const before = current.projection.source.slice(0, current.projection.offset);
      if (!context.explicit && !/[\w\u4e00-\u9fff.:"'` ]$/.test(before)) { return null; }
      const identity = current.binding.identity();
      const result = await owner.engine.complete(current.binding, current.projection);
      if (context.aborted || identity !== current.binding.identity()) { return null; }
      return { from: result.from, to: result.to, options: result.items.map(item => owner.item(item, current.projection)) };
    };
    const signature = async (view: EditorView) => {
      const current = owner.current(model, view.state.doc.toString(), view.state.selection.main.head, view);
      if (!current || !view.hasFocus) { return null; }
      const docs = await documentation(owner.settings.value.language.documentationLanguage);
      const text = current.projection.source.slice(0, current.projection.offset).split('\n').slice(-31).join('\n');
      const help = docs.get_signature_help(text);
      if (!help) { return null; }
      return { pos: view.state.selection.main.head, above: true, create: () => {
        const dom = document.createElement('div'); dom.className = 'ddb-signature'; dom.setAttribute('role', 'tooltip');
        const label = document.createElement('code'), active = help.signature.parameters[help.active_parameter];
        const start = active ? help.signature.full.indexOf(active.full, help.signature.full.indexOf('(')) : -1;
        if (start >= 0) {
          label.append(help.signature.full.slice(0, start)); const mark = document.createElement('mark'); mark.textContent = active.full;
          label.append(mark, help.signature.full.slice(start + active.full.length));
        } else { label.textContent = help.signature.full; }
        dom.append(label);
        if (active) { const detail = document.createElement('div'); detail.textContent = `参数 ${help.active_parameter + 1}/${help.signature.parameters.length} · ${active.name}`; dom.append(detail); }
        const documentation = help.documentation_md ? owner.renderMarkdown(help.documentation_md) : null;
        if (documentation) { dom.append(documentation.dom); }
        return { dom, destroy: () => documentation?.destroy() };
      } } satisfies Tooltip;
    };
    const decorations = (view: EditorView): DecorationSet => {
      // Use the current text: Jupyter updates the MIME type after this view update
      // when a user edits %%ddb into %ddb (or vice versa).
      // A windowed cell's host getter is unavailable until its editor constructor
      // finishes. Highlighting only depends on the shared text/model binding.
      if (!owner.bindings.has(model)) { return Decoration.none; }
      const text = view.state.doc.toString(), marks: { from: number; to: number; value: Decoration }[] = [];
      for (const region of ddbRegions(text).filter(r => r.kind === 'line')) {
        highlightTree(owner.language.language.parser.parse(text.slice(region.from, region.to)), tokenClasses, (from, to, classes) => {
          marks.push({ from: region.from + from, to: region.from + to, value: Decoration.mark({ class: classes }) });
        });
      }
      return Decoration.set(marks.sort((a, b) => a.from - b.from).map(m => m.value.range(m.from, m.to)));
    };
    return [
      signatureField,
      autocompletion({ override: [source], defaultKeymap: false, activateOnTyping: true, maxRenderedOptions: 80 }),
      Prec.highest(keymap.of([
        { key: 'Tab', run: view => hasNextSnippetField(view.state) ? nextSnippetField(view) : acceptCompletion(view) || Boolean(view.state.selection.main.empty && /\S/.test(view.state.sliceDoc(view.state.doc.lineAt(view.state.selection.main.head).from, view.state.selection.main.head)) && start(view)) },
        { key: 'Shift-Tab', run: view => hasPrevSnippetField(view.state) ? prevSnippetField(view) : false },
        ...completionKeymap.filter(binding => binding.key !== 'Ctrl-Space'),
        { key: 'Ctrl-Space', run: start },
        { key: 'Mod-Shift-Space', run: view => { void signature(view).then(value => view.dispatch({ effects: signatureEffect.of(value) })); return Boolean(owner.current(model, view.state.doc.toString(), view.state.selection.main.head, view)); } },
        { key: 'F12', run: view => { const current = owner.current(model, view.state.doc.toString(), view.state.selection.main.head, view); if (!current) { return false; } void owner.jump(view, model); return true; } },
      ])),
      hoverTooltip(async (view, position) => {
        if (!owner.settings.value.language.hoverDocumentation) { return null; }
        const current = owner.current(model, view.state.doc.toString(), position, view);
        if (!current) { return null; }
        const line = view.state.doc.lineAt(position);
        const word = [...line.text.matchAll(/[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*!?/g)].find(m => m.index! + line.from <= position && m.index! + line.from + m[0].length >= position);
        if (!word) { return null; }
        const [local, docs] = await Promise.all([owner.engine.hover(current.binding, current.projection), documentation(owner.settings.value.language.documentationLanguage)]);
        const content = local?.contents;
        const markdown = content && !Array.isArray(content) && typeof content !== 'string' && 'value' in content ? content.value : docs.get_function_markdown(word[0]);
        return markdown && owner.settings.value.language.hoverDocumentation ? { pos: line.from + word.index!, end: line.from + word.index! + word[0].length, above: true, create: () => owner.renderMarkdown(markdown) } : null;
      }),
      linter(async view => {
        if (!owner.settings.value.language.diagnostics) { return []; }
        const text = view.state.doc.toString();
        const region = ddbRegions(text, model.mimeType === 'text/x-dolphindb' && !/^%%ddb\b/.test(text))[0];
        const current = region && owner.current(model, text, region.from, view);
        if (!current) { return []; }
        const doc = TextDocument.create('', '', 0, current.projection.source);
        const diagnostics = await owner.engine.diagnostics(current.binding, current.projection);
        if (!owner.settings.value.language.diagnostics) { return []; }
        return diagnostics.map(diagnostic => ({
          from: doc.offsetAt(diagnostic.range.start) - current.projection.base,
          to: doc.offsetAt(diagnostic.range.end) - current.projection.base,
          severity: 'warning' as const, message: typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value,
        })).filter(d => d.from >= 0 && d.to <= text.length);
      }, { delay: 750 }),
      // Higher-precedence marks are innermost, so Python syntax colors cannot
      // override a DDB token within a %ddb line.
      Prec.highest(ViewPlugin.fromClass(class {
        decorations: DecorationSet;
        timer: ReturnType<typeof setTimeout> | undefined;
        generation = 0;
        constructor(readonly view: EditorView) {
          const views = owner.views.get(model) ?? new Set(); views.add(view); owner.views.set(model, views);
          this.decorations = decorations(view);
          owner.settings.changed.connect(this.settingsChanged, this);
        }
        private settingsChanged(): void {
          clearTimeout(this.timer); this.generation++;
          this.view.dispatch({ effects: [signatureEffect.of(null), closeHoverTooltips] });
          forceLinting(this.view);
        }
        update(update: import('@codemirror/view').ViewUpdate) {
          if (update.view.hasFocus) { owner.active = { model, view: update.view }; }
          if (update.docChanged || update.transactions.some(tr => tr.effects.some(effect => effect.is(bindingEffect)))) {
            this.decorations = decorations(update.view);
          }
          if (update.docChanged || update.selectionSet || update.focusChanged) {
            const generation = ++this.generation;
            clearTimeout(this.timer);
            if (!owner.settings.value.language.signatureHelp) { return; }
            this.timer = setTimeout(() => { void signature(this.view).then(value => {
              if (generation === this.generation) { this.view.dispatch({ effects: signatureEffect.of(value) }); }
            }); }, 80);
          }
        }
        destroy() {
          owner.settings.changed.disconnect(this.settingsChanged, this); this.generation++; clearTimeout(this.timer);
          const views = owner.views.get(model); views?.delete(this.view);
          if (!views?.size) { owner.views.delete(model); }
          if (owner.active?.view === this.view) { owner.active = null; }
        }
      }, { decorations: plugin => plugin.decorations })),
    ];
  }
}
