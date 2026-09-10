import type { Position, Range, CompletionItem } from 'vscode-languageserver-types';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { SymbolService } from '../upstream/language/symbols';
import type { MetadataDatabase } from './metadata';

export type MetadataRequest = (operation: string, arguments_: Record<string, string>) => Promise<unknown>;
export interface ModuleDocument { filePath: string; moduleName: string; source: string }
export interface TextDocumentPositionParams { textDocument: { uri: string }; position: Position }
export interface LanguageHost {
  documents: Map<string, TextDocument>;
  symbolService: SymbolService;
  dbService: MetadataDatabase;
  ddbModules: { getModules(): ModuleDocument[]; getIsInitModuleIndex(): boolean };
}
export interface DdbRegion { from: number; to: number; kind: 'file' | 'cell' | 'line'; header: number }
export interface Projection {
  source: string; offset: number; base: number; region: DdbRegion;
}
export interface LanguageBinding {
  path(): string;
  source(): string;
  project(source: string, offset: number): Projection | null;
  metadata: MetadataRequest;
  identity(): unknown;
  nativeComplete?(): boolean;
  open(uri: string, range: Range): Promise<void>;
}
export interface Suggestions { from: number; to: number; items: CompletionItem[] }
