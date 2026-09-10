import type { ISessionContext } from '@jupyterlab/apputils';
import type { INotebookCellExecutor } from '@jupyterlab/notebook';
import type { NotebookConnection } from './model';

/** Like SQL magics, IPython alone interprets user code, assignments and errors.
 * The adapter only orders automatic extension/configuration messages before cells.
 */
export function withDdbReadiness(
  executor: INotebookCellExecutor,
  modelFor: (context: ISessionContext) => NotebookConnection | undefined,
): INotebookCellExecutor {
  const pending = new WeakMap<ISessionContext, Promise<void>>();
  return {
    async runCell(options) {
      const context = options.sessionContext;
      if (context && options.cell.model.type === 'code' && !context.isTerminating && !context.pendingInput) {
        let gate = pending.get(context);
        if (!gate) {
          gate = Promise.resolve().then(async () => {
            if (context.hasNoKernel) {
              const select = await context.startKernel();
              if (select && options.sessionDialogs) { await options.sessionDialogs.selectKernel(context); }
            }
            if (!context.hasNoKernel) { await modelFor(context)?.readyForExecution(); }
          });
          pending.set(context, gate);
        }
        // Run All shares one barrier so Python cells cannot overtake each other.
        try {
          await gate;
        } finally {
          if (pending.get(context) === gate) { pending.delete(context); }
        }
      }
      return executor.runCell(options);
    },
  };
}
