// IndexedDB 草稿儲存：每個帳號的每份文件一筆，整份快照寫入。
// 交易使用 durability: 'strict'，交易 complete 事件之後才視為「已存本機」。
// M2-c 附錄 B3：草稿依帳號與頁面分區，鍵為 draft:<帳號 ID>:<頁面 ID>。每個帳號只讀寫自己分區的草稿；
// 其他帳號的草稿在產品介面中看不到、讀不到、不能下載或刪除，也看不到數量。
// 舊資料（M2-b 以前的 doc:<頁面 ID>）在資料庫版本 1 → 2 的升級交易中一次搬移：有 userId 的搬到該帳號的分區，
// 沒有或無法辨識 userId 的搬到隔離區 orphan:<頁面 ID>:<序號>（不載入、不送出、不自動刪除）。
// 升級是單一交易：中途中斷（分頁關閉、當掉）就全部不生效，舊資料原封不動，下次開啟再做。
const DB_NAME = 'notes-drafts';
const STORE = 'drafts';
const VERSION = 2;

export const draftKey = (userId, pageId) => `draft:${userId}:${pageId}`;
const userRange = userId => IDBKeyRange.bound(`draft:${userId}:`, `draft:${userId}:￿`);
const ORPHANS = () => IDBKeyRange.bound('orphan:', 'orphan:￿');
export const pageIdOfKey = key => String(key).split(':').pop();

// 有尚未同步的內容（待確認的修改、未確認的衝突副本、離線衝突副本、被拒絕的修改）
export const isUnsynced = v => !!(v && ((v.pending && v.pending.length) || (v.unackedCopies && v.unackedCopies.length) || v.offlineCopy || (v.denied && v.denied.length)));

// 升級時搬移舊資料（在 versionchange 交易內執行）
function migrateLegacy(tx) {
  const store = tx.objectStore(STORE);
  let n = 0;
  const req = store.openCursor(IDBKeyRange.bound('doc:', 'doc:￿'));
  req.onsuccess = () => {
    const cur = req.result;
    if (!cur) return;
    // 測試用：在搬移中途中斷升級（驗證整個升級回滾、舊資料不變）
    if (n > 0 && globalThis.__notesIdbUpgradeFail) { tx.abort(); return; }
    const pageId = String(cur.key).slice(4);
    const v = cur.value;
    const uid = v && typeof v.userId === 'string' && v.userId ? v.userId : null;
    const target = uid ? draftKey(uid, pageId) : `orphan:${pageId}:${Date.now()}-${n}`;
    // 不覆寫既有資料：目標已存在時改放隔離區
    const check = store.get(target);
    check.onsuccess = () => {
      store.put(v, check.result === undefined ? target : `orphan:${pageId}:${Date.now()}-${n}-dup`);
      cur.delete();
      n++;
      cur.continue();
    };
  };
}

// 畫面用：升級被其他分頁擋住（blocked＝true，畫面提示關閉或重新整理其他分頁）、收到新版本的升級通知時通知訂閱者。
// 同一個分頁裡先開啟資料庫的元件（例如側邊欄）會收到 blocked 事件，所以狀態集中在這裡，所有訂閱者都看得到
export const idbStatus = { blocked: false, versionChanged: false, listeners: new Set() };
const notify = () => { for (const f of idbStatus.listeners) f(idbStatus); };

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = e => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (e.oldVersion >= 1 && e.oldVersion < 2) migrateLegacy(req.transaction);
    };
    req.onblocked = () => { idbStatus.blocked = true; notify(); };
    req.onsuccess = () => {
      const db = req.result;
      // 新版本的程式要升級時讓出連線，避免擋住升級
      db.onversionchange = () => { db.close(); idbStatus.versionChanged = true; notify(); };
      if (idbStatus.blocked) { idbStatus.blocked = false; notify(); }
      resolve(db);
    };
    req.onerror = () => { if (idbStatus.blocked) { idbStatus.blocked = false; notify(); } reject(req.error); };
  });
}

async function cursorOver(range, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor(range);
    req.onsuccess = () => { const cur = req.result; if (!cur) { resolve(); return; } fn(cur.key, cur.value); cur.continue(); };
    req.onerror = () => reject(req.error);
  });
}

export class IdbStore {
  constructor(key) { this.key = key; this.dbp = openDb(); this.writes = 0; }

  // 這個帳號在這一頁的草稿
  static forPage(userId, pageId) { return new IdbStore(draftKey(userId, pageId)); }

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

  // 某個帳號自己尚未同步的草稿（登出前檢查、側邊欄「未同步」標示）
  static async unsyncedFor(userId) {
    const out = [];
    await cursorOver(userRange(userId), (key, value) => { if (isUnsynced(value)) out.push({ key, value }); });
    return out;
  }

  // 某個帳號在此裝置上的所有草稿（含已同步）
  static async draftsFor(userId) {
    const out = [];
    await cursorOver(userRange(userId), (key, value) => out.push({ key, value }));
    return out;
  }

  // 刪除某個帳號在此裝置上的所有草稿（已確認沒有未同步內容，或使用者已二次確認捨棄時才呼叫）
  static async clearUser(userId) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
      tx.objectStore(STORE).delete(userRange(userId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // 刪除指定的草稿；只接受這個帳號自己的鍵（不能刪除其他帳號的草稿）
  static async deleteOwn(userId, keys) {
    const prefix = `draft:${userId}:`;
    const own = keys.filter(k => String(k).startsWith(prefix));
    if (!own.length) return 0;
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
      for (const k of own) tx.objectStore(STORE).delete(k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return own.length;
  }

  // 無法辨識所有者的舊草稿：只提供中性的數量與（二次確認後的）清除
  static async orphanCount() {
    let n = 0;
    await cursorOver(ORPHANS(), () => { n++; });
    return n;
  }

  static async clearOrphans() {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
      tx.objectStore(STORE).delete(ORPHANS());
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
