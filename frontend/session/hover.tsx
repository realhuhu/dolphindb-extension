import * as React from 'react';
import { createPortal } from 'react-dom';
import { Tooltip, type TooltipElement } from '@jupyter/react-components';
import type { DisplayValue } from '../dos/runtime';
import type { WorkspaceBinding } from './types';

type Hover<Item> = { item: Item; anchor: HTMLElement; text: string; loading: boolean; value?: DisplayValue };
const activeHovers = new WeakMap<WorkspaceBinding, () => void>();

/** One delayed preview per workspace; responses and caches belong to a metadata snapshot. */
export function useWorkspaceHover<Item>(binding: WorkspaceBinding, options: {
  snapshot: () => unknown; key: (item: Item) => string; read: (item: Item) => Promise<DisplayValue>;
  blocked?: (item: Item) => string | null; error: string;
}) {
  const [hover, setHover] = React.useState<Hover<Item> | null>(null);
  const id = React.useId();
  const state = React.useRef({ sequence: 0, show: undefined as ReturnType<typeof setTimeout> | undefined,
    hide: undefined as ReturnType<typeof setTimeout> | undefined, inTooltip: false, cache: new Map<string, Promise<DisplayValue>>() });
  const revision = binding.identity(), snapshot = options.snapshot();
  const dismiss = React.useCallback(() => {
    clearTimeout(state.current.show); clearTimeout(state.current.hide);
    state.current.sequence++; state.current.inTooltip = false; setHover(null);
    if (activeHovers.get(binding) === dismiss) { activeHovers.delete(binding); }
  }, [binding]);
  React.useLayoutEffect(() => {
    dismiss(); state.current.cache.clear();
    return dismiss;
  }, [revision, snapshot, dismiss]);
  React.useEffect(() => {
    const outside = (event: Event) => { if (!(event.target instanceof Element) || !event.target.closest('.ddb-workspace-tooltip')) { dismiss(); } };
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' || event.key === 'Enter') { dismiss(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keydown);
    document.addEventListener('scroll', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('scroll', outside, true);
    };
  }, [dismiss]);
  const keep = () => { state.current.inTooltip = true; clearTimeout(state.current.hide); };
  const leave = () => {
    clearTimeout(state.current.show); clearTimeout(state.current.hide);
    if (state.current.inTooltip) { return; }
    state.current.hide = setTimeout(dismiss, 150);
  };
  const leaveTooltip = () => { state.current.inTooltip = false; leave(); };
  const enter = (item: Item, anchor: HTMLElement) => {
    activeHovers.get(binding)?.();
    dismiss(); activeHovers.set(binding, dismiss);
    const sequence = state.current.sequence;
    const current = () => sequence === state.current.sequence && binding.isCurrent()
      && binding.identity() === revision && options.snapshot() === snapshot && anchor.isConnected;
    state.current.show = setTimeout(() => {
      if (!current()) { return; }
      const blocked = options.blocked?.(item) ?? (binding.model.executing ? '会话正在运行，请在运行完成后预览。' : null);
      const initial = { item, anchor, loading: !blocked, text: blocked ?? '正在读取…' };
      setHover(initial);
      if (blocked) { return; }
      const key = options.key(item);
      let pending = state.current.cache.get(key);
      if (!pending) {
        pending = options.read(item);
        state.current.cache.set(key, pending);
        void pending.catch(() => { if (state.current.cache.get(key) === pending) { state.current.cache.delete(key); } });
      }
      void pending.then(value => { if (current()) { setHover({ ...initial, value, loading: false }); } },
        () => { if (current()) { setHover({ ...initial, text: options.error, loading: false }); } });
    }, 350);
  };
  return { id, hover, enter, leave, leaveTooltip, keep, dismiss };
}

export type WorkspaceHover<Item> = ReturnType<typeof useWorkspaceHover<Item>>;

export function WorkspaceTooltip({ controller, anchor, viewport, children }: {
  controller: Pick<WorkspaceHover<unknown>, 'id' | 'dismiss' | 'keep' | 'leaveTooltip'>;
  anchor: HTMLElement; viewport: HTMLElement; children: React.ReactNode;
}): React.ReactPortal {
  // Jupyter absolutely positions its shell; body/html can have a zero-height box.
  const ref = React.useCallback((tooltip: TooltipElement | null) => {
    if (tooltip) { tooltip.viewportElement = viewport; }
  }, [viewport]);
  // Lumino panels use contain: strict, clipping even fixed-position descendants.
  return createPortal(<Tooltip ref={ref} id={controller.id} className="ddb-workspace-tooltip" anchorElement={anchor} visible
    position="left" autoUpdateMode="auto" horizontalViewportLock verticalViewportLock
    onDismiss={controller.dismiss} onMouseEnter={controller.keep} onMouseLeave={controller.leaveTooltip}>
    {children}
  </Tooltip>, document.body);
}
