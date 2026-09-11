import { Token } from '@lumino/coreutils';
import type { ConnectionModel } from './model';
import type { DosManager } from './dos/model';

export const IConnectionModel = new Token<ConnectionModel>('dolphindb-extension:IConnectionModel');
export const IDosManager = new Token<DosManager>('dolphindb-extension:IDosManager');
