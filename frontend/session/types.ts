import type { ISignal } from '@lumino/signaling';
import type { DatabaseEntry, VariableEntry, DisplayValue } from '../dos/runtime';
import type { BrowseRequest, DataPage, DataTarget } from '../data/types';

/** Data always belongs to the document's execution session or pre-run preview. */
export interface WorkspaceModel {
  readonly changed: ISignal<any, void>;
  readonly profile: { name: string } | null | undefined;
  readonly locked: boolean;
  readonly executing: boolean;
  readonly debugging?: boolean;
  readonly panelLoading: boolean;
  readonly status: string;
  readonly databases: DatabaseEntry[];
  readonly variables: VariableEntry[];
  readonly databaseError: string | null;
  readonly variablesError: string | null;
  refreshPanels(): Promise<void>;
  inspectTable(database: string, table: string): Promise<void>;
  previewVariable(name: string): Promise<DisplayValue>;
  previewTableSchema(database: string, table: string): Promise<DisplayValue>;
  browse(target: DataTarget, request: BrowseRequest): Promise<DataPage>;
  browserIdentity(): string;
  setPanelActive?(active: boolean): void;
}

export interface WorkspaceBinding {
  model: WorkspaceModel;
  path: () => string;
  scope: 'file' | 'kernel';
  identity: () => string;
  isCurrent: () => boolean;
  captureInsertion: (name: string | (() => string)) => (() => void) | null;
  openData?: (target: DataTarget, title: string) => void;
}
