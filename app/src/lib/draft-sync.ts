// 登出前同步與下載本機草稿（M2-c W5、SEC-12）：只處理目前帳號自己分區的草稿。
// - syncDrafts：為每份有待送修改的草稿建立一條協作連線（不開編輯器），最多等待 timeoutMs；
//   協定與編輯器相同（M1：重送未確認的 update_id、還原後先存衝突副本），完成後中斷連線
// - describeDrafts：把尚未同步的草稿轉成可下載的 JSON（頁面、格式版本、匯出時間、內容、待確認的修改、衝突副本、失去權限的修改）；
//   不含任何登入或協作憑證
import { BlockNoteEditor } from '@blocknote/core';
import { yDocToBlocks } from '@blocknote/core/yjs';
import { Client } from '@shared/client.js';
import { IdbStore, isUnsynced, pageIdOfKey } from '@shared/idb-store.js';
import { schema, FRAGMENT } from '@shared/blocknote-schema.js';

type Draft = { key: string; value: Record<string, unknown> };
let converter: BlockNoteEditor<any, any, any> | null = null;
const describe = (ydoc: unknown) => JSON.stringify(yDocToBlocks((converter ||= BlockNoteEditor.create({ schema })), ydoc as never, FRAGMENT));

function clientFor(userId: string, d: Draft, persist: IdbStore | null) {
  const pageId = pageIdOfKey(d.key);
  const c = new Client({
    url: '', docId: pageId, token: '', userId, name: '', storage: persist ? d.value : structuredClone(d.value), persist, describe,
    autoReconnect: true, livenessMs: 8000,
    getToken: async () => {
      const r = await fetch(`/api/pages/${pageId}/collab-token`, { method: 'POST', cache: 'no-store' });
      if (!r.ok) { const e = new Error('collab token ' + r.status) as Error & { status: number }; e.status = r.status; throw e; }
      const j = await r.json();
      c.url = j.url;
      return j.token;
    },
  });
  return c;
}

// 可以補送的草稿：有待確認的修改或衝突副本；失去權限（denied）的修改不再送出
const sendable = (v: Record<string, unknown>) => {
  const s = v as { pending?: unknown[]; unackedCopies?: unknown[]; offlineCopy?: unknown };
  return !!((s.pending && s.pending.length) || (s.unackedCopies && s.unackedCopies.length) || s.offlineCopy);
};

export async function syncDrafts(userId: string, timeoutMs = 10000, onProgress?: (left: number) => void): Promise<Draft[]> {
  const drafts = (await IdbStore.unsyncedFor(userId)).filter(d => sendable(d.value));
  const clients = drafts.map(d => clientFor(userId, d, IdbStore.forPage(userId, pageIdOfKey(d.key))));
  for (const c of clients) { try { c.connect(); } catch { /* 草稿不屬於此帳號等情況：留給下一步處理 */ } }
  const deadline = Date.now() + timeoutMs;
  const busy = (c: InstanceType<typeof Client>) => !c.blocked && !c.revoked && sendable(c.storage) && !c.storage.denied.length;
  while (Date.now() < deadline && clients.some(busy)) {
    if (onProgress) onProgress(Math.ceil((deadline - Date.now()) / 1000));
    await new Promise(r => setTimeout(r, 100));
  }
  // 等最後一次本機寫入完成再中斷
  const until = Date.now() + 2000;
  while (Date.now() < until && clients.some(c => !c.localPersisted())) await new Promise(r => setTimeout(r, 20));
  for (const c of clients) c.disconnect();
  return (await IdbStore.unsyncedFor(userId)).filter(d => isUnsynced(d.value));
}

export async function describeDrafts(userId: string, formatVersion = 1) {
  const drafts = await IdbStore.unsyncedFor(userId);
  return {
    formatVersion, exportedAt: new Date().toISOString(),
    drafts: drafts.map(d => {
      const c = clientFor(userId, d, null);
      const dl = c.downloadUnsynced();
      return { pageId: pageIdOfKey(d.key), blocks: JSON.parse(dl.json || '[]'), pending: dl.pending, copies: dl.copies, denied: (c.deniedDraft() as { updates: unknown[] }).updates };
    }),
  };
}
