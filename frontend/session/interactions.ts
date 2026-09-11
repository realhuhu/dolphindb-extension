import type { CodeEditor } from '@jupyterlab/codeeditor';

export function loadTableExpression(database: string, table: string): string {
  return `loadTable(${JSON.stringify(database)}, ${JSON.stringify(table)})`;
}

/** Coalesce repeated clicks and allow only one request per action at a time. */
export class DebouncedActions {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Set<string>();
  private disposed = false;
  constructor(private onError: (error: unknown) => void, readonly delay = 250) {}

  schedule(key: string, action: () => void | Promise<void>): void {
    if (this.disposed || this.running.has(key)) { return; }
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (this.disposed) { return; }
      this.running.add(key);
      void Promise.resolve().then(() => { if (!this.disposed) { return action(); } }).catch(error => {
        if (!this.disposed) { this.onError(error); }
      }).finally(() => this.running.delete(key));
    }, this.delay));
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) { clearTimeout(timer); }
    this.timers.clear();
  }
}

/** Preserve the editor/selection that was active when the sidebar was clicked. */
export function captureVariableInsertion(editor: CodeEditor.IEditor | null | undefined, name: string,
  isCurrent: () => boolean, activate: () => void = () => {}): (() => void) | null {
  if (!editor || editor.isDisposed || editor.getOption('readOnly') || !isCurrent()) { return null; }
  const source = editor.model.sharedModel.getSource();
  const selection = JSON.stringify(editor.getSelection());
  return () => {
    if (editor.isDisposed || editor.getOption('readOnly') || !isCurrent()
      || editor.model.sharedModel.getSource() !== source || JSON.stringify(editor.getSelection()) !== selection) { return; }
    const range = editor.getSelection();
    const offsets = [editor.getOffsetAt(range.start), editor.getOffsetAt(range.end)].sort((a, b) => a - b);
    // Yjs otherwise merges a sidebar insertion with adjacent typing in its capture window.
    const shared = editor.model.sharedModel as typeof editor.model.sharedModel & { undoManager?: { stopCapturing(): void } | null };
    shared.undoManager?.stopCapturing();
    shared.updateSource(offsets[0], offsets[1], name);
    shared.undoManager?.stopCapturing();
    const cursor = editor.getPositionAt(offsets[0] + name.length)!;
    editor.setSelection({ start: cursor, end: cursor });
    activate();
    editor.focus();
  };
}
