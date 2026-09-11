/** Document-owned state survives output updates and closing/reopening an editor. */
export class OutputFolding {
  collapsed = false;
  private defaultExpanded = true;
  private entries = new Map<string, boolean>();

  expanded(id: string): boolean { return this.entries.get(id) ?? this.defaultExpanded; }

  setExpanded(id: string, expanded: boolean): void { this.entries.set(id, expanded); }

  setAll(expanded: boolean): void {
    this.defaultExpanded = expanded;
    this.entries.clear();
  }

  retain(ids: string[]): void {
    const current = new Set(ids);
    for (const id of this.entries.keys()) { if (!current.has(id)) { this.entries.delete(id); } }
  }
}
