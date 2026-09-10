import type { JupyterFrontEndPlugin } from '@jupyterlab/application';
import type { ISessionContext } from '@jupyterlab/apputils';
import { INotebookCellExecutor, runCell } from '@jupyterlab/notebook';
import type { ConnectionModel } from '../model';
import { IConnectionModel } from '../tokens';
import { withDdbReadiness } from './executor';
import { NotebookConnection } from './model';

const models = new WeakMap<ISessionContext, NotebookConnection>();

/** Share a model between the toolbar and executor, including cloned notebook views. */
export function notebookConnection(context: ISessionContext, connections: ConnectionModel): NotebookConnection {
  let model = models.get(context);
  if (!model) {
    model = new NotebookConnection(context, connections);
    models.set(context, model);
    context.disposed.connect(() => {
      model!.dispose();
      models.delete(context);
    });
  }
  return model;
}

/** Replace the default provider through Jupyter's supported service token. */
export default {
  id: 'dolphindb-extension:notebook-cell-executor',
  autoStart: true,
  provides: INotebookCellExecutor,
  requires: [IConnectionModel],
  activate: (_app, connections: ConnectionModel) =>
    Object.freeze(withDdbReadiness({ runCell }, context => notebookConnection(context, connections))),
} satisfies JupyterFrontEndPlugin<INotebookCellExecutor>;
