import { Token } from '@lumino/coreutils';
import type { ConnectionModel } from './model';

export const IConnectionModel = new Token<ConnectionModel>('dolphindb-extension:IConnectionModel');
