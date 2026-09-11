import { LabIcon } from '@jupyterlab/ui-components';
import { createElement, type IconNode, FileCode, Notebook, Eye, Table2, Play, Square,
  RefreshCw, Plus, Settings, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eraser, PanelRight,
  Circle, CircleCheck, LoaderCircle } from 'lucide';
import connectionsSvg from '../style/icons/dolphindb-connections.svg';
import dataExplorerSvg from '../style/icons/dolphindb-data-explorer.svg';

/** Lucide outlines wrapped in Jupyter's native icon API, with theme-aware strokes. */
function outline(name: string, node: IconNode): LabIcon {
  const svg = createElement(node, { class: 'ddb-outline-icon', 'stroke-width': 1.75 });
  return new LabIcon({ name: `dolphindb-extension:${name}`, svgstr: svg.outerHTML });
}

export const connectionsIcon = new LabIcon({ name: 'dolphindb-extension:connections', svgstr: connectionsSvg });
export const dataExplorerIcon = new LabIcon({ name: 'dolphindb-extension:data-explorer', svgstr: dataExplorerSvg });
export const dosIcon = outline('dos', FileCode);
export const notebookIcon = outline('notebook-file', Notebook);
export const previewIcon = outline('preview', Eye);
export const tableIcon = outline('table', Table2);
export const runIcon = outline('run', Play);
export const stopIcon = outline('stop', Square);
export const refreshIcon = outline('refresh', RefreshCw);
export const addIcon = outline('add', Plus);
export const settingsIcon = outline('settings-icon', Settings);
export const caretDownIcon = outline('chevron-down', ChevronDown);
export const caretRightIcon = outline('chevron-right', ChevronRight);
export const collapseAllIcon = outline('collapse-all', ChevronsDownUp);
export const expandAllIcon = outline('expand-all', ChevronsUpDown);
export const clearIcon = outline('clear', Eraser);
export const workspaceIcon = outline('show-workspace', PanelRight);
export const readyIcon = outline('ready', CircleCheck);
export const idleIcon = outline('idle', Circle);
export const busyIcon = outline('busy', LoaderCircle);
