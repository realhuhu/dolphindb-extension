import * as React from 'react';
import { Dialog, ReactWidget, showDialog } from '@jupyterlab/apputils';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Result } from '../dos/output';
import type { DisplayValue } from '../dos/runtime';

export function showTablePreview(result: { title: string; value: DisplayValue }, rendermime: IRenderMimeRegistry): void {
  const body = ReactWidget.create(<Result value={result.value} rendermime={rendermime}/>);
  body.addClass('ddb-table-preview');
  void showDialog({ title: result.title, body, buttons: [Dialog.okButton({ label: '关闭' })] });
}
