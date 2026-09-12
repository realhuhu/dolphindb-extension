import * as React from 'react';
import { Dialog, ReactWidget, showDialog, showErrorMessage } from '@jupyterlab/apputils';
import { HTMLSelect, ReactiveToolbar, Toolbar, ToolbarButton, type LabIcon } from '@jupyterlab/ui-components';
import { DisposableDelegate } from '@lumino/disposable';
import type { ISignal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { idleIcon, readyIcon, busyIcon, workspaceIcon } from '../icons';

/** Guard the native DOS host toolbar without patching Jupyter's shared prototype. */
export function guardToolbarDisposal(toolbar: Toolbar): DisposableDelegate {
  if (!(toolbar instanceof ReactiveToolbar) || toolbar.onAfterShow !== ReactiveToolbar.prototype.onAfterShow) {
    return new DisposableDelegate(() => {});
  }
  // Jupyter exposes no completion-aware overflow refresh. Keep this compatibility
  // adapter limited to its existing limiter: invoke(true) performs both native
  // measurement passes, whereas fit()/resize can skip or coalesce the second one.
  const resizer = (toolbar as unknown as { _resizer?: {
    stop(): Promise<void>; invoke(callTwice: boolean): Promise<unknown>;
  } })._resizer;
  if (!resizer || typeof resizer.stop !== 'function' || typeof resizer.invoke !== 'function') {
    return new DisposableDelegate(() => {});
  }
  const afterShow = toolbar.onAfterShow;
  let generation = 0, disposed = false;
  const show = () => {
    const current = ++generation;
    const live = () => !disposed && !toolbar.isDisposed && toolbar.isVisible && current === generation;
    void resizer.stop().then(() => {
      if (live()) { return resizer.invoke(true); }
    }).catch(error => {
      if (live() && error !== undefined) { console.error('Unable to resize DolphinDB toolbar', error); }
    });
  };
  toolbar.onAfterShow = show;
  return new DisposableDelegate(() => {
    disposed = true;
    if (toolbar.onAfterShow === show) { toolbar.onAfterShow = afterShow; }
  });
}

type ProfileOption = { id: string; name: string };
export interface SessionControlsState {
  profiles: ProfileOption[];
  profile: ProfileOption | null | undefined;
  defaultProfile: ProfileOption | undefined;
  selection: string;
  locked: boolean;
  busy: boolean;
  disabled: boolean;
  canClose: boolean;
  status: string;
  label: string;
  closeDescription: string;
  select: (id: string) => Promise<void>;
  close: () => void | Promise<void>;
  showWorkspace: () => void;
}

export interface SessionToolbarAction {
  name: string;
  label: string;
  tooltip: string;
  icon?: LabIcon;
  run: () => unknown;
  enabled?: () => boolean;
  visible?: () => boolean;
}

class ConnectionPicker extends ReactWidget {
  constructor(private state: () => SessionControlsState, private select: (id: string) => void) { super(); this.addClass('ddb-connection-picker'); }
  render(): React.ReactElement {
    const state = this.state();
    const missing = state.profile && !state.profiles.some(profile => profile.id === state.profile!.id);
    const icon = state.busy ? busyIcon : state.locked ? readyIcon : idleIcon;
    return <>
      <icon.react className="jp-Toolbar-kernelStatus" elementSize="normal"/>
      <HTMLSelect aria-label={state.label} title={state.locked ? '连接已固定。关闭会话后可重新选择。' : '首次运行前可切换连接。'}
        value={state.selection} disabled={state.disabled} onChange={event => this.select(event.target.value)}
        options={[{ value: '', label: '默认连接' + (state.defaultProfile ? ' · ' + state.defaultProfile.name : '') },
          ...state.profiles.map(profile => ({ value: profile.id, label: profile.name })),
          ...(missing ? [{ value: state.profile!.id, label: state.profile!.name }] : [])]}/>
    </>;
  }
}

/** Native toolbar sizing, overflow, buttons and focus handling for both document types. */
export class SessionToolbar extends ReactiveToolbar {
  private readonly toolbarGuard: DisposableDelegate;
  private closing = false;
  private picker: ConnectionPicker;
  private status = new Widget();
  private closeButton: ToolbarButton;
  private buttons: { button: ToolbarButton; action: SessionToolbarAction }[] = [];
  constructor(private options: { label: string; changed: ISignal<any, void>; state: () => SessionControlsState; actions: SessionToolbarAction[] }) {
    super();
    this.toolbarGuard = guardToolbarDisposal(this);
    this.addClass('ddb-session-toolbar');
    this.node.setAttribute('aria-label', options.label);
    for (const action of options.actions) {
      const button = new ToolbarButton({ label: action.label, tooltip: action.tooltip, icon: action.icon,
        onClick: () => { void Promise.resolve().then(action.run).catch(error => showErrorMessage('DolphinDB', error)); } });
      this.addItem(action.name, button);
      this.buttons.push({ button, action });
    }
    this.addItem('spacer', Toolbar.createSpacerItem());
    this.picker = new ConnectionPicker(() => ({ ...options.state(), disabled: options.state().disabled || this.closing }), id => {
      void options.state().select(id).catch(error => showErrorMessage('无法切换 DolphinDB 连接', error));
    });
    this.addItem('connection', this.picker);
    this.status.addClass('ddb-session-status');
    this.status.node.setAttribute('role', 'status');
    this.addItem('status', this.status);
    this.closeButton = new ToolbarButton({ label: '关闭会话', tooltip: '释放当前 DolphinDB 会话的变量，允许重新选择连接', onClick: () => void this.closeSession() });
    this.addItem('shutdown', this.closeButton);
    this.addItem('workspace', new ToolbarButton({ icon: workspaceIcon, tooltip: '显示数据库与变量', onClick: () => options.state().showWorkspace() }));
    options.changed.connect(this.refresh, this);
    this.refresh();
  }
  private async closeSession(): Promise<void> {
    if (this.closing || !this.options.state().canClose) { return; }
    this.closing = true; this.refresh();
    const state = this.options.state();
    try {
      const result = await showDialog({ title: '关闭 DolphinDB 会话', body: state.closeDescription,
        buttons: [Dialog.cancelButton({ label: '取消' }), Dialog.warnButton({ label: '关闭会话' })] });
      if (result.button.accept) { await state.close(); }
    } catch (error) { await showErrorMessage('无法关闭 DolphinDB 会话', error as Error); }
    finally { this.closing = false; if (!this.isDisposed) { this.refresh(); } }
  }
  private refresh(): void {
    const state = this.options.state();
    this.picker.update();
    this.status.node.textContent = state.status;
    this.status.node.title = state.status;
    this.closeButton.enabled = state.canClose && !this.closing;
    for (const { button, action } of this.buttons) {
      button.enabled = action.enabled?.() ?? true;
      button.setHidden(!(action.visible?.() ?? true));
    }
    this.fit();
  }
  dispose(): void {
    if (this.isDisposed) { return; }
    this.toolbarGuard.dispose();
    this.options.changed.disconnect(this.refresh, this);
    super.dispose();
  }
}
