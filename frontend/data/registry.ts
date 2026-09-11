import type { DdbObj } from 'dolphindb/browser.js';
import type { BrowseRequest, DataPage, DataTicket } from './types';
import { objectPage } from './sdk';
import { getPreferences } from './preferences';
import { FIRST_PAGE } from './types';

export function defaultPage(): BrowseRequest {
  const { pageSize, columnPageSize } = getPreferences().dataBrowser;
  return { ...FIRST_PAGE, path: [], limit: pageSize, columnLimit: columnPageSize };
}

// Keep the latest result even when it alone exceeds the budget. Older results
// are evicted instead of retaining every large array in execution history.
const snapshots = new Map<string, { obj: DdbObj; bytes: number }>();
let retained = 0;
export function snapshotTicket(obj: DdbObj, title = '执行结果'): DataTicket | undefined {
  let initial: DataPage;
  const initialRequest = defaultPage();
  try { initial = objectPage(obj, initialRequest); }
  catch { return undefined; } // A new/unsupported SDK form must not turn a successful execution into an error.
  const id = crypto.randomUUID();
  const bytes = obj.buffer?.byteLength ?? Math.max(1024, (obj.rows ?? 1) * (obj.cols ?? 1) * 8);
  snapshots.set(id, { obj, bytes }); retained += bytes;
  trimSnapshots();
  return { owner: 'browser', target: { kind: 'result', id }, title, initial, initialRequest };
}
function trimSnapshots(): void {
  const { cacheEntries, cacheMegabytes } = getPreferences().advanced;
  while (snapshots.size > 1 && (snapshots.size > cacheEntries || retained > cacheMegabytes * 1024 * 1024)) {
    const [old, entry] = snapshots.entries().next().value!; snapshots.delete(old); retained -= entry.bytes;
  }
}
export async function readSnapshot(id: string, request: BrowseRequest): Promise<DataPage> {
  trimSnapshots();
  const entry = snapshots.get(id);
  if (!entry) { throw new Error('此结果的浏览缓存已释放，请重新运行代码，或从变量面板查看。'); }
  return objectPage(entry.obj, request);
}
