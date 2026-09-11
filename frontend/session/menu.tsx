import * as React from 'react';
import { CommandRegistry } from '@lumino/commands';
import { Menu } from '@lumino/widgets';
import { ToolbarButtonComponent } from '@jupyterlab/ui-components';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { moreIcon } from '../icons';

export interface MenuAction { label: string; run: () => void | Promise<void> }
/** Native Lumino menus provide focus restoration, Escape and keyboard navigation. */
export function openActions(actions: MenuAction[], x: number, y: number): void {
  const commands = new CommandRegistry();
  const menu = new Menu({ commands });
  actions.forEach((action, index) => {
    const command = String(index);
    commands.addCommand(command, { label: action.label, execute: () => Promise.resolve().then(action.run).catch(error =>
      showDialog({ title: action.label, body: error instanceof Error ? error.message : String(error), buttons: [Dialog.okButton({ label: '关闭' })] })) });
    menu.addItem({ command });
  });
  menu.aboutToClose.connect(() => { setTimeout(() => menu.dispose(), 0); });
  menu.open(x, y);
}
export function ActionsButton({ title, actions, enabled = true }: { title: string; actions: () => MenuAction[]; enabled?: boolean }): React.ReactElement {
  const host = React.useRef<HTMLSpanElement>(null);
  return <span className="ddb-actions-button" ref={host} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <ToolbarButtonComponent icon={moreIcon} tooltip={title} enabled={enabled} onClick={() => {
      const rect = host.current!.getBoundingClientRect(); openActions(actions(), rect.left, rect.bottom);
    }}/>
  </span>;
}
