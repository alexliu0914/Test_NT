// 協作用戶端（Node.js 測試與瀏覽器共用同一份程式碼；M1 由 M0 原型移植，儲存協定不變）
// M1 新增：getToken（每次連線前取得新的 5 分鐘協作憑證）、關閉代碼 4003（憑證失效→換新重連）、4004（頁面已關閉）
// - storage：執行中的草稿狀態（待確認清單、文件更新、已知 restore_epoch……）
// - persist：選用的本機儲存介面（瀏覽器為 IndexedDB）。沒有提供時，storage 物件本身視為已落盤（Node 測試用）。
// - 儲存狀態：saved＝伺服器已確認；saving／failed＝伺服器尚未確認、但已寫入本機；unsaved＝連本機都還沒寫入完成。
import * as Y from 'yjs';
import { Emitter, uuid, b64, fromB64 } from './util.js';
import { insertToken, deleteRandomToken, deleteRandomBlock, docJSON, fragment } from './doc.js';

const REMOTE = 'remote';
const LOAD = 'load';
export const LOCAL = 'local';

export class Client extends Emitter {
  constructor({
    url, docId, token, userId, name = 'A', storage = {}, failAfterMs = 10000, autoReconnect = true,
    rnd = Math.random, trackReceived = false, clearUndoOnRestore = true,
    WebSocketImpl = globalThis.WebSocket, persist = null, describe = docJSON, getToken = null,
  }) {
    super();
    Object.assign(this, { url, docId, token, userId, name, storage, failAfterMs, autoReconnect, rnd, trackReceived, clearUndoOnRestore, WebSocketImpl, persist, describe, getToken });
    this.pageClosed = false;
    this.connectAttempt = 0;
    this.ready = false;
    this.revoked = false;
    this.closedByUser = false;
    this.ws = null;
    this.received = [];      // 從伺服器收到的所有更新（測試用）
    this.lastSaved = null;   // 最後一次「已儲存」當下的完整狀態（測試用）
    this.blocked = null;
    this.version = 0;          // 本機狀態每變動一次加 1
    this.persistedVersion = 0; // 已寫入本機儲存的版本
    this.saving = false;
    this.saveAgain = false;
    this.extraUndoManagers = new Set();
    storage.pending ||= [];
    storage.docUpdates ||= [];
    storage.pendingRestores ||= [];
    storage.unackedCopies ||= [];
    if (storage.knownEpoch === undefined) storage.knownEpoch = null;
    if (storage.userId && storage.userId !== userId && (storage.pending.length || storage.unackedCopies.length || storage.offlineCopy)) {
      // 這台裝置上有其他帳號尚未儲存的草稿：必須先下載或捨棄
      this.blocked = 'other_user_drafts';
    } else if (storage.userId && storage.userId !== userId) {
      this.clearStorage();
    }
    if (!this.blocked) storage.userId ||= userId;
    this.initDoc();
  }

  initDoc() {
    this.ydoc = new Y.Doc();
    for (const u of this.storage.docUpdates) Y.applyUpdate(this.ydoc, u, LOAD);
    this.undoManager = new Y.UndoManager(fragment(this.ydoc), { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
    this.ydoc.on('update', (u, origin) => {
      if (origin === LOAD) return;
      this.storage.docUpdates.push(u);
      if (this.storage.docUpdates.length > 400) this.storage.docUpdates = [Y.mergeUpdates(this.storage.docUpdates)];
      if (origin === REMOTE) { this.touch(); return; }
      const entry = { id: uuid(), data: u, at: Date.now() };
      this.storage.pending.push(entry);
      entry.v = this.touch();
      this.emit('local', entry);
      this.sendUpdate(entry);
    });
  }

  // 套用伺服器送來的更新（M2 F-M2-01）
  // - Yjs 先整合資料再呼叫觀察者；觀察者（編輯器繫結）丟出的例外不影響已整合的資料，不能讓它中斷協定處理
  //   （例如重新連線時套用狀態後停在未就緒、待確認項目永遠不重送）
  // - this.repair（選用）在同一個交易中修復結構，觀察者只會看到修復後的文件；修復的內容另外當作本機更新送出
  applyRemote(data) {
    let sv = null;
    let repaired = 0;
    try {
      this.ydoc.transact(() => {
        Y.applyUpdate(this.ydoc, data);
        if (this.repair) { sv = Y.encodeStateVector(this.ydoc); repaired = this.repair(this.ydoc); }
      }, REMOTE);
    } catch (e) {
      this.emit('observer_error', e);
    }
    if (repaired) this.enqueueLocal(Y.encodeStateAsUpdate(this.ydoc, sv));
  }

  enqueueLocal(u) {
    const entry = { id: uuid(), data: u, at: Date.now() };
    this.storage.pending.push(entry);
    entry.v = this.touch();
    this.emit('local', entry);
    this.sendUpdate(entry);
  }

  // ---- 本機儲存 ----
  touch() {
    this.version += 1;
    if (!this.persist) { this.persistedVersion = this.version; return this.version; }
    this.flushLocal();
    return this.version;
  }

  snapshot() {
    const s = this.storage;
    return {
      userId: s.userId, knownEpoch: s.knownEpoch, offlineCopy: s.offlineCopy || null,
      pending: s.pending.map(({ id, covers, data, at }) => ({ id, covers, data, at })),
      docUpdates: [...s.docUpdates], pendingRestores: [...s.pendingRestores], unackedCopies: [...s.unackedCopies],
    };
  }

  async flushLocal() {
    if (this.saving) { this.saveAgain = true; return; }
    this.saving = true;
    try {
      do {
        this.saveAgain = false;
        const v = this.version;
        await this.persist.save(this.snapshot());
        this.persistedVersion = Math.max(this.persistedVersion, v);
        this.emit('local_persisted', v);
      } while (this.saveAgain);
    } catch (e) {
      this.emit('local_error', e);
    } finally { this.saving = false; }
  }

  localPersisted() {
    return this.persistedVersion >= this.version;
  }

  get pending() { return this.storage.pending; }

  saveStatus() {
    const p = this.storage.pending;
    if (p.length === 0 && !this.storage.offlineCopy && this.storage.unackedCopies.length === 0) return 'saved';
    // 有修改連本機都還沒寫入完成：此時關閉頁面可能遺失
    if (p.some(e => (e.v || 0) > this.persistedVersion) || !this.localPersisted()) return 'unsaved';
    if (p.length === 0) return 'saving';
    const oldest = Math.min(...p.map(e => e.at));
    return Date.now() - oldest > this.failAfterMs ? 'failed' : 'saving';
  }

  // ---- 連線 ----
  connect() {
    if (this.blocked) throw new Error('blocked: ' + this.blocked);
    this.closedByUser = false;
    this.revoked = false;
    if (!this.getToken) { this.openSocket(); return; }
    // 每次連線前換一張新的協作憑證；401＝登入已失效，404＝頁面已不存在
    const attempt = ++this.connectAttempt;
    Promise.resolve().then(() => this.getToken()).then(tok => {
      if (this.closedByUser || attempt !== this.connectAttempt) return;
      this.token = tok;
      this.openSocket();
    }, e => {
      if (this.closedByUser || attempt !== this.connectAttempt) return;
      if (e && e.status === 401) { this.revoked = true; this.emit('revoked'); return; }
      if (e && e.status === 404) { this.pageClosed = true; this.emit('page_closed'); return; }
      if (this.autoReconnect) setTimeout(() => { if (!this.closedByUser) this.connect(); }, 1000);
    });
  }

  openSocket() {
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => this.raw({ t: 'hello', docId: this.docId, token: this.token }));
    ws.addEventListener('message', ev => this.onMessage(JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())));
    ws.addEventListener('close', ev => {
      if (this.ws !== ws) return;
      const wasReady = this.ready;
      this.ready = false;
      this.emit('disconnected', ev.code);
      if (ev.code === 4001) { this.revoked = true; this.emit('revoked'); return; }
      if (ev.code === 4004) { this.pageClosed = true; this.emit('page_closed'); return; }
      // 4003：憑證無效或過期。有 getToken 時換新憑證重連；沒有（固定憑證）就停止，避免無限重試
      if (ev.code === 4003 && !this.getToken) { this.emit('token_rejected', ev.reason); return; }
      // 連續失敗時指數退避（第一次 25～75 毫秒，最長約 5 秒），避免離線時不停向網頁伺服器換憑證
      const fails = this.reconnectFails = (this.reconnectFails || 0) + (wasReady ? 0 : 1);
      const base = Math.min(5000, 50 * 2 ** Math.min(fails, 7));
      if (this.autoReconnect && !this.closedByUser) setTimeout(() => { if (!this.closedByUser && this.ws === ws) this.connect(); }, Math.floor(base * (0.5 + Math.random())));
    });
    ws.addEventListener('error', () => {});
  }

  dropSocket(ws) {
    try { if (ws.terminate) ws.terminate(); else ws.close(); } catch { /* ignore */ }
  }

  disconnect() {
    this.closedByUser = true;
    this.ready = false;
    if (this.ws) { const ws = this.ws; this.ws = null; this.dropSocket(ws); }
  }

  raw(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  sendUpdate(entry) {
    // 背壓等待中：先不送，等重送計時器到時合併後一起送
    if (!this.ready || this.busyTimer) return;
    this.raw({ t: 'update', id: entry.id, covers: entry.covers, data: b64(entry.data) });
  }

  onMessage(m) {
    // 等待衝突副本確認時，只處理確認與重新連線的 welcome（確認後會重新連線並重新載入）
    if (this.awaitingOfflineCopy && m.t !== 'cc_ack' && m.t !== 'welcome') return undefined;
    switch (m.t) {
      case 'welcome': return this.onWelcome(m);
      case 'remote': return this.onRemote(m);
      case 'ack': return this.onAck(m);
      case 'busy': return this.onBusy(m);
      case 'restore_result':
        this.storage.pendingRestores = this.storage.pendingRestores.filter(r => r.restoreId !== m.restoreId);
        this.touch();
        return this.emit('restore_result', m);
      case 'cc_ack': return this.onCopyAck(m);
      case 'version_ok': return this.emit('version_ok', m);
      default: return undefined;
    }
  }

  onWelcome(m) {
    const st = this.storage;
    const known = st.knownEpoch;
    if (known !== null && m.epoch > known && st.pending.length > 0) {
      // 離線期間頁面被還原，且本機有未確認修改：在套用任何伺服器狀態之前先保存原始本機內容
      if (!st.offlineCopy) {
        st.offlineCopy = { copyId: uuid(), basedEpoch: known, state: b64(Y.encodeStateAsUpdate(this.ydoc)), json: this.describe(this.ydoc) };
        this.touch();
      }
      this.awaitingOfflineCopy = st.offlineCopy.copyId;
      this.emit('conflict_copy_sent', { ...st.offlineCopy, kind: 'offline' });
      this.raw({ t: 'conflict_copy', ...st.offlineCopy });
      return;
    }
    const state = fromB64(m.state);
    this.applyRemote(state);
    if (this.trackReceived) this.received.push(state);
    if (known !== null && m.epoch > known) this.clearUndo();
    st.knownEpoch = m.epoch;
    this.touch();
    this.ready = true;
    this.reconnectFails = 0;
    for (const c of st.unackedCopies) this.raw({ t: 'conflict_copy', ...c });
    for (const e of st.pending) this.sendUpdate(e);
    for (const r of st.pendingRestores) this.raw({ t: 'restore', ...r });
    this.markSavedIfClean();
    this.emit('ready');
  }

  clearUndo() {
    if (!this.clearUndoOnRestore) return;
    this.undoManager.clear();
    for (const um of this.extraUndoManagers) um.clear();
  }

  // 編輯器自己的 Undo 堆疊（例如 BlockNote／y-prosemirror）也要在還原時清空
  registerUndoManager(um) { this.extraUndoManagers.add(um); }

  onRemote(m) {
    const data = fromB64(m.data);
    if (m.restore) {
      const st = this.storage;
      if (st.pending.length > 0) {
        // 線上收到還原時仍有未確認修改：套用前先另存衝突副本
        const copy = { copyId: uuid(), basedEpoch: st.knownEpoch, state: b64(Y.encodeStateAsUpdate(this.ydoc)), json: this.describe(this.ydoc) };
        st.unackedCopies.push(copy);
        this.touch();
        this.emit('conflict_copy_sent', { ...copy, kind: 'online' });
        this.raw({ t: 'conflict_copy', ...copy });
      }
      this.applyRemote(data);
      st.knownEpoch = m.restore.epoch;
      this.touch();
      this.clearUndo();
      if (this.trackReceived) this.received.push(data);
      this.markSavedIfClean();
      this.emit('restored', m.restore);
      return;
    }
    this.applyRemote(data);
    if (this.trackReceived) this.received.push(data);
    this.markSavedIfClean();
    this.emit('remote', m);
  }

  onAck(m) {
    const ids = new Set(m.ids);
    const before = this.storage.pending.length;
    this.storage.pending = this.storage.pending.filter(e => !ids.has(e.id));
    if (this.storage.pending.length !== before) { this.touch(); this.emit('acked', m.ids); }
    this.markSavedIfClean();
  }

  // 伺服器暫時無法接收（背壓）：保留在待確認清單，稍後重送。
  // 同一段等待期間只排一次重送，並先把待確認項目合併成一筆（covers 保留原 id），避免逐筆重送造成訊息風暴
  onBusy(m) {
    this.emit('busy', m);
    if (this.busyTimer) return;
    this.busyTimer = setTimeout(() => {
      this.busyTimer = null;
      if (!this.ready) return;           // 重新連線時會重送全部待確認項目
      this.mergePending();
      for (const e of this.storage.pending) this.sendUpdate(e);
    }, m.retryAfterMs || 500);
  }

  onCopyAck(m) {
    const st = this.storage;
    if (this.awaitingOfflineCopy === m.copyId) {
      // 衝突副本已保存：捨棄本機版本，重新從伺服器載入
      this.awaitingOfflineCopy = null;
      const copy = st.offlineCopy;
      st.offlineCopy = null;
      st.pending = [];
      st.docUpdates = [];
      st.knownEpoch = null;
      this.touch();
      this.initDoc();
      this.emit('offline_conflict_resolved', copy);
      const ws = this.ws;
      this.ws = null;
      this.dropSocket(ws);
      this.connect();
      return;
    }
    st.unackedCopies = st.unackedCopies.filter(c => c.copyId !== m.copyId);
    this.touch();
    this.emit('copy_acked', m.copyId);
  }

  markSavedIfClean() {
    if (this.storage.pending.length === 0 && this.ready) {
      if (this.trackReceived) this.lastSaved = { state: Y.encodeStateAsUpdate(this.ydoc), at: Date.now() };
      this.emit('saved');
    }
  }

  // ---- 編輯操作（Node 測試用；瀏覽器中由編輯器直接修改 ydoc） ----
  // 等待衝突副本確認期間，編輯器為唯讀（避免這段時間的輸入被捨棄）
  assertEditable() { if (this.awaitingOfflineCopy) throw new Error('read-only while saving conflict copy'); }
  isReadOnly() { return !!this.awaitingOfflineCopy || !!this.blocked; }
  type(token, newBlock = false) {
    this.assertEditable();
    this.ydoc.transact(() => insertToken(this.ydoc, token, this.rnd, newBlock), LOCAL);
    const last = this.storage.pending[this.storage.pending.length - 1];
    return last ? last.id : null;
  }
  del() { this.assertEditable(); let t = null; this.ydoc.transact(() => { t = deleteRandomToken(this.ydoc, this.rnd); }, LOCAL); return t; }
  delBlock() { this.assertEditable(); let t = []; this.ydoc.transact(() => { t = deleteRandomBlock(this.ydoc, this.rnd); }, LOCAL); return t; }
  undo() { this.undoManager.undo(); }
  redo() { this.undoManager.redo(); }

  // 把多筆待確認更新合併為一筆，covers 記錄原本所有 update_id
  mergePending() {
    const p = this.storage.pending;
    if (p.length < 2) return false;
    const covers = p.flatMap(e => [e.id, ...(e.covers || [])]);
    this.storage.pending = [{ id: uuid(), covers, data: Y.mergeUpdates(p.map(e => e.data)), at: Math.min(...p.map(e => e.at)), v: this.version + 1 }];
    this.touch();
    return true;
  }

  restore(versionId, restoreId = uuid()) {
    const r = { restoreId, versionId };
    this.storage.pendingRestores.push(r);
    this.touch();
    if (this.ready) this.raw({ t: 'restore', ...r });
    return restoreId;
  }

  makeVersion(versionId) {
    return new Promise(res => {
      const h = m => { if (m.versionId === versionId) { this.off('version_ok', h); res(m); } };
      this.on('version_ok', h);
      this.raw({ t: 'make_version', versionId });
    });
  }

  // ---- 登出與本機草稿 ----
  clearStorage() {
    for (const k of Object.keys(this.storage)) delete this.storage[k];
    this.storage.pending = [];
    this.storage.docUpdates = [];
    this.storage.pendingRestores = [];
    this.storage.unackedCopies = [];
    this.storage.knownEpoch = null;
  }

  hasUnsynced() {
    const st = this.storage;
    return st.pending.length > 0 || st.unackedCopies.length > 0 || !!st.offlineCopy;
  }

  async logout({ waitMs = 10000 } = {}) {
    const deadline = Date.now() + waitMs;
    while (this.hasUnsynced() && Date.now() < deadline && !this.revoked) await new Promise(r => setTimeout(r, 20));
    if (this.hasUnsynced()) return { status: 'unsynced', count: this.storage.pending.length };
    this.disconnect();
    this.clearStorage();
    if (this.persist) await this.persist.clear();
    return { status: 'logged_out' };
  }

  downloadUnsynced() {
    return {
      userId: this.storage.userId,
      json: this.describe(this.ydoc),
      pending: this.storage.pending.map(e => ({ id: e.id, covers: e.covers, data: b64(e.data) })),
      copies: this.storage.unackedCopies,
    };
  }

  async discardAndLogout({ confirm = false } = {}) {
    if (!confirm) return { status: 'confirm_required' };
    this.disconnect();
    this.clearStorage();
    if (this.persist) await this.persist.clear();
    this.blocked = null;
    this.storage.userId = this.userId;
    this.initDoc();
    return { status: 'logged_out_discarded' };
  }
}
