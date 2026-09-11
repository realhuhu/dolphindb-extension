/** Document-owned state survives output updates and closing/reopening an editor. */
export class OutputFolding {
  collapsed = false;
  private defaultExpanded = true;
  private defaultOverridden = false;
  private entries = new Map<string, boolean>();

  expanded(id: string): boolean { return this.entries.get(id) ?? this.defaultExpanded; }

  setExpanded(id: string, expanded: boolean): void { this.entries.set(id, expanded); }
  setDefault(expanded: boolean): void { if (!this.defaultOverridden) { this.defaultExpanded = expanded; } }

  setAll(expanded: boolean): void {
    this.defaultExpanded = expanded;
    this.defaultOverridden = true;
    this.entries.clear();
  }

  retain(ids: string[]): void {
    const current = new Set(ids);
    for (const id of this.entries.keys()) { if (!current.has(id)) { this.entries.delete(id); } }
    for (const id of ids) { if (!this.entries.has(id)) { this.entries.set(id, this.defaultExpanded); } }
  }
}
