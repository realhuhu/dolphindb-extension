import { Compartment, RangeSet, StateEffect, StateField, Prec } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from '@codemirror/view';
import { CodeMirrorEditor } from '@jupyterlab/codemirror';
import type { CodeEditor } from '@jupyterlab/codeeditor';
import type { DosDebugSession } from './session';

class BreakMarker extends GutterMarker {
  constructor(readonly verified: boolean) { super(); }
  eq(other: BreakMarker): boolean { return this.verified === other.verified; }
  toDOM(): HTMLElement {
    const node = document.createElement('span');
    node.className = `ddb-debug-breakpoint${this.verified ? ' ddb-mod-verified' : ''}`;
    node.title = this.verified ? '已验证断点 · 点击移除' : '断点尚未验证 · 点击移除';
    return node;
  }
}

/** CodeMirror's native gutter and mapped positions keep breakpoints on edited lines. */
export class DebugEditor {
  private compartment = new Compartment();
  private effect = StateEffect.define<{ points: { pos: number; verified: boolean }[]; line: number | null }>();
  private points: StateField<RangeSet<BreakMarker>>;
  private highlight: StateField<DecorationSet>;
  private updating = false;
  private disposed = false;
  private lastFrame: DosDebugSession['frame'] = null;
  private view: EditorView;
  constructor(readonly editor: CodeEditor.IEditor, private session: DosDebugSession, private path: () => string, private save: () => void) {
    if (!(editor instanceof CodeMirrorEditor)) { throw new Error('DOS 调试需要 CodeMirror 编辑器。'); }
    this.view = editor.editor;
    this.points = StateField.define({
      create: () => RangeSet.empty,
      update: (points, tr) => {
        points = points.map(tr.changes);
        for (const effect of tr.effects) {
          if (effect.is(this.effect)) { points = RangeSet.of(effect.value.points.map(p => new BreakMarker(p.verified).range(p.pos)), true); }
        }
        return points;
      },
    });
    this.highlight = StateField.define<DecorationSet>({
      create: () => Decoration.none,
      update: (value, tr) => {
        value = value.map(tr.changes);
        for (const effect of tr.effects) {
          if (effect.is(this.effect)) { value = effect.value.line === null ? Decoration.none : Decoration.set([Decoration.line({ class: 'ddb-debug-current-line' }).range(effect.value.line)]); }
        }
        return value;
      }, provide: field => EditorView.decorations.from(field),
    });
    this.view.dispatch({ effects: StateEffect.appendConfig.of(this.compartment.of([
      this.points, this.highlight,
      Prec.highest(gutter({
        class: 'ddb-debug-gutter', renderEmptyElements: true,
        markers: view => view.state.field(this.points), initialSpacer: () => new BreakMarker(false),
        domEventHandlers: { mousedown: (view, line, event) => {
          if ((event as MouseEvent).button !== 0) { return false; }
          event.preventDefault(); this.toggle(view.state.doc.lineAt(line.from).number - 1); return true;
        } },
      })),
      EditorView.updateListener.of(update => {
        if (!update.docChanged || this.updating || this.disposed) { return; }
        const lines: number[] = [];
        update.state.field(this.points).between(0, update.state.doc.length, from => { lines.push(update.state.doc.lineAt(from).number - 1); });
        // A collaborative edit can bypass the local read-only option. Stop rather than
        // displaying a paused location against a different program.
        if (this.session.active && this.path() === this.session.path) { void this.session.stop(); }
        queueMicrotask(() => {
          if (this.disposed) { return; }
          void this.session.setBreakpoints(this.path(), lines); this.save();
        });
      }),
    ])) });
    session.changed.connect(this.sync, this); this.sync();
  }
  toggle(line = this.editor.getCursorPosition().line): void {
    const path = this.path(), points = this.session.breaks.get(path) ?? [];
    const lines = points.some(p => p.line === line) ? points.filter(p => p.line !== line).map(p => p.line) : [...points.map(p => p.line), line];
    void this.session.setBreakpoints(path, lines); this.save();
  }
  sync(): void {
    if (this.disposed || this.editor.isDisposed) { return; }
    const doc = this.view.state.doc, path = this.path();
    const points = (this.session.breaks.get(path) ?? []).filter(p => p.line < doc.lines).map(p => ({ pos: doc.line(p.line + 1).from, verified: p.verified }));
    const frame = this.session.paused ? this.session.frame : null;
    const line = frame && this.session.sourcePath(frame.moduleName) === path && frame.line >= 0 && frame.line < doc.lines ? doc.line(frame.line + 1).from : null;
    this.updating = true;
    try { this.view.dispatch({ effects: this.effect.of({ points, line }) }); }
    finally { this.updating = false; }
    if (frame !== this.lastFrame) { this.lastFrame = frame; if (line !== null && frame) { this.reveal(frame.line); } }
  }
  reveal(line: number): void {
    if (line < 0 || line >= this.editor.lineCount) { return; }
    this.editor.setCursorPosition({ line, column: 0 }); this.editor.revealPosition({ line, column: 0 });
  }
  dispose(): void {
    if (this.disposed) { return; } this.disposed = true;
    this.session.changed.disconnect(this.sync, this);
    if (!this.editor.isDisposed) { this.view.dispatch({ effects: this.compartment.reconfigure([]) }); }
  }
}
