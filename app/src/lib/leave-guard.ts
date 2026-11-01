'use client';
// 離開頁面的提醒（M2-b W3）：目前的頁面有尚未同步的修改時，站內切換頁面前先等最多 1.5 秒讓它同步；
// 仍未同步就詢問使用者（內容已保存在此裝置，下次開啟該頁時補送）。關閉分頁另由 beforeunload 提醒。
type Guard = { unsynced: () => number; waitClean: (ms: number) => Promise<boolean> };
let guard: Guard | null = null;
let asker: ((n: number) => Promise<boolean>) | null = null;

export function setLeaveGuard(g: Guard) { guard = g; return () => { if (guard === g) guard = null; }; }
export function setLeaveAsker(fn: ((n: number) => Promise<boolean>) | null) { asker = fn; }

export async function canLeave(): Promise<boolean> {
  const g = guard;
  if (!g || g.unsynced() === 0) return true;
  if (await g.waitClean(1500)) return true;
  return asker ? asker(g.unsynced()) : true;
}
