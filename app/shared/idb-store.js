// IndexedDB 草稿儲存：每份文件一筆，整份快照寫入。
// 交易使用 durability: 'strict'，交易 complete 事件之後才視為「已存本機」。
const DB_NAME = 'notes-drafts';
const STORE = 'drafts';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbStore {
  constructor(key) { this.key = key; this.dbp = openDb(); this.writes = 0; }

  async load() {
    const db = await this.dbp;
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(this.key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async save(snapshot) {
    const db = await this.dbp;
    // 測試用：延後寫入，模擬慢速磁碟，驗證「尚未存到本機」狀態
    if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
      tx.objectStore(STORE).put(snapshot, this.key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
    this.writes++;
  }

  // 這台裝置上「其他帳號」尚未同步的草稿（任何文件）
  static async otherUserDrafts(userId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const out = [];
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(out); return; }
        const v = cur.value || {};
        const unsynced = (v.pending && v.pending.length) || (v.unackedCopies && v.unackedCopies.length) || v.offlineCopy || (v.denied && v.denied.length);
        if (v.userId && v.userId !== userId && unsynced) out.push({ key: cur.key, value: v });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // 某個帳號自己尚未同步的草稿（登出前檢查用）
  static async unsyncedFor(userId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const out = [];
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(out); return; }
        const v = cur.value || {};
        const unsynced = (v.pending && v.pending.length) || (v.unackedCopies && v.unackedCopies.length) || v.offlineCopy || (v.denied && v.denied.length);
        if (v.userId === userId && unsynced) out.push({ key: cur.key, value: v });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // 刪除某個帳號在此裝置上的所有草稿（已確認沒有未同步內容時才呼叫）
  static async clearUser(userId) {
    const db = await openDb();
    const keys = await new Promise((resolve, reject) => {
      const out = [];
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      req.onsuccess = () => { const cur = req.result; if (!cur) { resolve(out); return; } if ((cur.value || {}).userId === userId) out.push(cur.key); cur.continue(); };
      req.onerror = () => reject(req.error);
    });
    if (keys.length) await IdbStore.deleteKeys(keys);
  }

  static async deleteKeys(keys) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
      for (const k of keys) tx.objectStore(STORE).delete(k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clear() {
    const db = await this.dbp;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
      tx.objectStore(STORE).delete(this.key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
