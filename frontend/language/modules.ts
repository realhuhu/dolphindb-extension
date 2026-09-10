import type { Contents } from '@jupyterlab/services';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getFileModule, SymbolService } from '../upstream/language/symbols';
import type { ModuleDocument } from './contracts';

/** Workspace reads use Jupyter Contents, including remote/custom contents managers. */
export class ModuleIndex {
  private roots = new Map<string, { updated: number; files: ModuleDocument[]; pending?: Promise<ModuleDocument[]> }>();
  readonly open = new Map<object, { path(): string; source(): string }>();
  readonly symbols = new SymbolService(async path => String((await this.contents.get(path, { type: 'file', format: 'text', content: true })).content));
  private sources = new Map<string, string>();
  constructor(private contents: Contents.IManager) {}
  refresh(): void { this.roots.clear(); }
  async list(root: string): Promise<ModuleDocument[]> {
    let cached = this.roots.get(root);
    if (!cached) { cached = { updated: 0, files: [] }; this.roots.set(root, cached); }
    if (!cached.pending && Date.now() - cached.updated > 15_000) {
      cached.pending = this.scan(root).then(files => { cached!.files = files; cached!.updated = Date.now(); return files; })
        .finally(() => { cached!.pending = undefined; });
    }
    const files = new Map((await (cached.pending ?? Promise.resolve(cached.files))).map(file => [file.filePath, file]));
    for (const opened of this.open.values()) {
      const path = opened.path();
      if (root && path !== root && !path.startsWith(root + '/')) { continue; }
      const source = opened.source(), moduleName = getFileModule(source);
      if (moduleName) { files.set(path, { filePath: path, source, moduleName }); }
      else { files.delete(path); }
    }
    for (const file of files.values()) {
      if (this.sources.get(file.filePath) !== file.source) {
        this.symbols.buildSymbolByDocument(TextDocument.create(file.filePath, 'dolphindb', 0, file.source));
        this.sources.set(file.filePath, file.source);
      }
    }
    return [...files.values()];
  }
  private async scan(root: string): Promise<ModuleDocument[]> {
    const files: ModuleDocument[] = [];
    const directories = [root];
    const skip = new Set(['node_modules', '.venv', 'venv', '.git', '__pycache__', '.ipynb_checkpoints']);
    while (directories.length) {
      const batch = directories.splice(0, 6);
      await Promise.all(batch.map(async path => {
        const listing = await this.contents.get(path, { content: true }).catch(() => null);
        if (listing?.type !== 'directory') { return; }
        const entries = listing.content as Contents.IModel[];
        for (const entry of entries) {
          if (entry.type === 'directory' && !skip.has(entry.name) && !entry.name.startsWith('.')) { directories.push(entry.path); }
          else if (entry.type === 'file' && entry.name.toLowerCase().endsWith('.dos')) {
            const data = await this.contents.get(entry.path, { type: 'file', format: 'text', content: true }).catch(() => null);
            if (typeof data?.content !== 'string') { continue; }
            const moduleName = getFileModule(data.content);
            if (moduleName) { files.push({ moduleName, filePath: entry.path, source: data.content }); }
          }
        }
      }));
    }
    return files;
  }
}
