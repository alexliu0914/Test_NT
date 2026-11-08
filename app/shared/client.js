// 協作用戶端（Node.js 測試與瀏覽器共用同一份程式碼；M1 由 M0 原型移植，儲存協定不變）
// M1 新增：getToken（每次連線前取得新的 5 分鐘協作憑證）、關閉代碼 4003（憑證失效→換新重連）、4004（頁面已關閉）
// - storage：執行中的草稿狀態（待確認清單、文件更新、已知 restore_epoch……）
// - persist：選用的本機儲存介面（瀏覽器為 IndexedDB）。沒有提供時，storage 物件本身視為已落盤（Node 測試用）。
// - 儲存狀態：saved＝伺服器已確認；saving／failed＝伺服器尚未確認、但已寫入本機；unsaved＝連本機都還沒寫入完成。
// M2-s 失去權限（關閉代碼 4005、P0-01）：
// - 待確認項目移到 storage.denied（「無權限」），永不自動重送、不自動重連；刪除本機從伺服器快取的文件狀態，只保留自己的修改
// - 之後權限恢復時也不自動補送：由使用者選擇下載、另存為衝突副本（不合併，伺服器仍依當下成員身分檢查）或捨棄
// M2-b：
// - 協作游標（W2）：this.awareness（y-protocols）只在連線時與伺服器交換，屬於暫態：不寫入本機草稿、待確認清單或文件更新，不影響儲存狀態。
//   名字與顏色以伺服器在 welcome 告知的為準（伺服器也會覆蓋轉送給其他人的狀態）；送出節流為每 100 毫秒最多一次。
//   斷線、撤銷、失去權限時清除其他人的游標。
// - 連線存活檢查（livenessMs，瀏覽器使用；Node 測試預設關閉）：網路中斷但 TCP 沒有關閉時，瀏覽器可能很久都不觸發 close，
//   畫面會停在「儲存中」再變成「儲存失敗」。已連線時每 livenessMs/4 送一次 ping，超過 livenessMs 沒有收到任何訊息就視為斷線，
//   改顯示「離線」並重新連線。瀏覽器的 offline 事件（goOffline）也立即視為斷線。
// - 五種儲存狀態（W3）：displayStatus()，判定規則見 save-state.js；伺服器的 {t:'db'} 通知資料庫寫入失敗與恢復
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { Emitter, uuid, b64, fromB64 } from './util.js';
import { deriveSaveState } from './save-state.js';
import { insertToken, deleteRandomToken, deleteRandomBlock, docJSON, fragment } from './doc.js';

const REMOTE = 'remote';
const LOAD = 'load';
export const LOCAL = 'local';

export class Client extends Emitter {
  constructor({
    url, docId, token, userId, name = 'A', storage = {}, failAfterMs = 10000, autoReconnect = true,
    rnd = Math.random, trackReceived = false, clearUndoOnRestore = true,
    WebSocketImpl = globalThis.WebSocket, persist = null, describe = docJSON, getToken = null, livenessMs = 0,
  }) {
    super();
    Object.assign(this, { url, docId, token, userId, name, storage, failAfterMs, autoReconnect, rnd, trackReceived, clearUndoOnRestore, WebSocketImpl, persist, describe, getToken, livenessMs });
    this.lastHeard = 0;
    this.livenessTimer = null;
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
    this.dbFailing = false;
    this.me = null;            // 伺服器確認的名字與顏色
    this.awTimer = null;
    this.awLastSent = 0;
    storage.pending ||= [];
    storage.docUpdates ||= [];
    storage.pendingRestores ||= [];
    storage.unackedCopies ||= [];
    storage.denied ||= [];
    if (storage.knownEpoch === undefined) storage.knownEpoch = null;
    if (storage.userId && storage.userId !== userId && (storage.pending.length || storage.unackedCopies.length || storage.offlineCopy || storage.denied.length)) {
      // 這台裝置上有其他帳號尚未儲存的草稿：必須先下載或捨棄
      this.blocked = 'other_user_drafts';
    } else if (storage.userId && storage.userId !== userId) {
      this.clearStorage();
    }
    if (!this.blocked) storage.userId ||= userId;
    this.initDoc();
  }

  initDoc() {
    if (this.awareness) this.awareness.destroy();
    this.ydoc = new Y.Doc();
    this.awareness = new Awareness(this.ydoc);
    // y-protocols 每 3 秒檢查逾時的計時器：不讓它單獨撐住 Node 行程（測試）
    const it = this.awareness._checkInterval;
    if (it && typeof it.unref === 'function') it.unref();
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      if (origin === REMOTE) return;
      const me = this.awareness.clientID;
      if (added.includes(me) || updated.includes(me) || removed.includes(me)) this.scheduleAwareness();
    });
    for (const u of this.storage.docUpdates) Y.applyUpdate(this.ydoc, u, LOAD);
    this.undoManager = new Y.UndoManager(fragment(this.ydoc), { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
    this.ydoc.on('update', (u, origin) => {
      if (origin === LOAD) return;
      if (this.accessDenied) {
        // 已失去權限：自己的修改只留在本機的「無權限」草稿，不送出；不再快取文件狀態
        if (origin !== REMOTE) { this.storage.denied.push({ id: uuid(), data: u, at: Date.now(), deniedAt: Date.now() }); this.touch(); }
        return;
      }
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
      denied: (s.denied || []).map(({ id, covers, data, at, deniedAt }) => ({ id, covers, data, at, deniedAt })),
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

  // 五種儲存狀態（M2-b W3）：unsaved／saved／offline／failed／saving，規則見 save-state.js
  displayStatus() {
    const st = this.storage;
    const p = st.pending;
    const unsynced = p.length > 0 || !!st.offlineCopy || st.unackedCopies.length > 0;
    return deriveSaveState({
      unsynced,
      // 「尚未存到此裝置」與 M1 的 saveStatus() 用同一個判斷（F-M2-11：不能另寫一份，M1 的保護與變異 MUT-B3 才涵蓋實際使用的程式）
      unpersisted: unsynced && this.saveStatus() === 'unsaved',
      connected: this.ready,
      dbFailing: this.dbFailing,
      oldestPendingAgeMs: p.length ? Date.now() - Math.min(...p.map(e => e.at)) : 0,
      failAfterMs: this.failAfterMs,
    });
  }

  // ---- 協作游標（M2-b W2） ----
  scheduleAwareness() {
    if (this.awTimer) return;
    const wait = Math.max(0, 100 - (Date.now() - this.awLastSent));
    this.awTimer = setTimeout(() => { this.awTimer = null; this.sendAwareness(); }, wait);
  }

  sendAwareness() {
    if (!this.ready || this.accessDenied || this.revoked) return;
    this.awLastSent = Date.now();
    this.raw({ t: 'aw', data: b64(encodeAwarenessUpdate(this.awareness, [this.awareness.clientID])) });
  }

  clearPeers() {
    if (!this.awareness) return;
    const others = [...this.awareness.getStates().keys()].filter(id => id !== this.awareness.clientID);
    if (others.length) { removeAwarenessStates(this.awareness, others, REMOTE); this.emit('peers'); }
  }

  // 同頁其他人的游標（名字、顏色都是伺服器確認的）
  peers() {
    const out = [];
    for (const [clientId, st] of this.awareness.getStates()) {
      if (clientId === this.awareness.clientID || !st || !st.user) continue;
      out.push({ clientId, name: st.user.name, color: st.user.color, cursor: !!st.cursor });
    }
    return out;
  }

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
    this.accessDenied = false;
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
    ws.addEventListener('message', ev => {
      if (ws.__closedHandled) return;   // 已判定斷線的舊連線：之後才到的訊息一律不處理
      this.lastHeard = Date.now();
      this.onMessage(JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()));
    });
    ws.addEventListener('close', ev => this.onSocketClosed(ws, ev.code, ev.reason));
    ws.addEventListener('error', () => {});
  }

  // 連線存活檢查：已連線時定期 ping；太久沒有收到任何訊息就視為斷線
  startLiveness() {
    if (!this.livenessMs || this.livenessTimer) return;
    this.livenessTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || !this.ready) return;
      const now = Date.now();
      if (now - this.lastHeard > this.livenessMs) { this.socketLost(ws); return; }
      if (now - (this.lastPing || 0) >= this.livenessMs / 4) { this.lastPing = now; this.raw({ t: 'ping' }); }
    }, Math.max(100, Math.floor(this.livenessMs / 16)));
    if (typeof this.livenessTimer.unref === 'function') this.livenessTimer.unref();
  }
  stopLiveness() { if (this.livenessTimer) { clearInterval(this.livenessTimer); this.livenessTimer = null; } }

  // 不等瀏覽器的 close 事件，直接當作斷線處理（之後重新連線）
  socketLost(ws) {
    if (!ws || ws.__closedHandled) return;
    this.onSocketClosed(ws, 1006);
    this.dropSocket(ws);
  }
  goOffline() { if (this.ws) this.socketLost(this.ws); }
  reconnectNow() { if (!this.ready && !this.closedByUser && !this.revoked && !this.accessDenied && !this.pageClosed && this.autoReconnect && !this.blocked) this.connect(); }

  onSocketClosed(ws, code, reason = '') {
    {
      const ev = { code, reason };
      if (this.ws !== ws || ws.__closedHandled) return;
      ws.__closedHandled = true;
      this.stopLiveness();
      const wasReady = this.ready;
      this.ready = false;
      this.dbFailing = false;
      this.clearPeers();
      this.emit('disconnected', ev.code);
      if (ev.code === 4001) { this.revoked = true; this.emit('revoked'); return; }
      if (ev.code === 4004) { this.pageClosed = true; this.emit('page_closed'); return; }
      if (ev.code === 4005) { this.onAccessDenied(); return; }
      // 4003：憑證無效或過期。有 getToken 時換新憑證重連；沒有（固定憑證）就停止，避免無限重試
      if (ev.code === 4003 && !this.getToken) { this.emit('token_rejected', ev.reason); return; }
      // 連續失敗時指數退避（第一次 25～75 毫秒，最長約 5 秒），避免離線時不停向網頁伺服器換憑證
      const fails = this.reconnectFails = (this.reconnectFails || 0) + (wasReady ? 0 : 1);
      const base = Math.min(5000, 50 * 2 ** Math.min(fails, 7));
      if (this.autoReconnect && !this.closedByUser) setTimeout(() => { if (!this.closedByUser && this.ws === ws) this.connect(); }, Math.floor(base * (0.5 + Math.random())));
    }
  }

  dropSocket(ws) {
    try { if (ws.terminate) ws.terminate(); else ws.close(); } catch { /* ignore */ }
  }

  disconnect() {
    this.closedByUser = true;
    this.ready = false;
    this.stopLiveness();
    if (this.awTimer) { clearTimeout(this.awTimer); this.awTimer = null; }
    this.clearPeers();
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
      case 'version_error': return this.emit('version_error', m);
      case 'denied': return this.markDenied(m.ids);
      case 'aw':
        try { applyAwarenessUpdate(this.awareness, fromB64(m.data), REMOTE); } catch { /* 格式錯誤的游標資料直接忽略 */ }
        return this.emit('peers');
      case 'db':
        this.dbFailing = !m.ok;
        return this.emit('db', m.ok);
      case 'pong': return undefined;
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
    this.dbFailing = false;
    this.reconnectFails = 0;
    this.lastHeard = Date.now();
    this.startLiveness();
    if (m.you) { this.me = m.you; this.awareness.setLocalStateField('user', m.you); }
    this.sendAwareness();
    for (const c of st.unackedCopies) this.raw({ t: 'conflict_copy', ...c });
    for (const e of st.pending) this.sendUpdate(e);
    for (const r of st.pendingRestores) this.raw({ t: 'restore', ...r });
    this.markSavedIfClean();
    this.emit('ready');
    // 失去權限前留下的草稿：不自動補送，由使用者選擇（下載、另存為衝突副本、捨棄）
    if (st.denied.length) this.emit('denied_drafts', st.denied.length);
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

  // ---- 失去權限（M2-s） ----
  // 伺服器拒絕的 update_id：從待確認清單移到「無權限」
  markDenied(ids) {
    const set = new Set(ids || []);
    const st = this.storage;
    const moved = st.pending.filter(e => set.has(e.id) || (e.covers || []).some(id => set.has(id)));
    if (!moved.length) return;
    st.pending = st.pending.filter(e => !moved.includes(e));
    st.denied.push(...moved.map(e => ({ ...e, deniedAt: Date.now() })));
    this.touch();
  }

  // 以 4005 關閉：所有待確認項目標為無權限；刪除從伺服器快取的文件狀態（其他人的內容），只保留自己的修改；不再重連
  onAccessDenied() {
    const st = this.storage;
    const now = Date.now();
    st.denied.push(...st.pending.map(e => ({ ...e, deniedAt: now })));
    st.pending = [];
    st.pendingRestores = [];
    st.docUpdates = [];
    st.knownEpoch = null;
    if (this.busyTimer) { clearTimeout(this.busyTimer); this.busyTimer = null; }
    this.accessDenied = true;
    this.closedByUser = true;
    this.touch();
    this.emit('access_denied', st.denied.length);
  }

  // 自己在失去權限前尚未同步的內容（只含自己的修改，不含其他人的內容）
  deniedDraft() {
    const st = this.storage;
    const text = [];
    for (const e of st.denied) {
      try {
        for (const s of Y.decodeUpdate(e.data).structs) {
          const c = s.content;
          if (c && typeof c.str === 'string' && c.str) text.push(c.str);
        }
      } catch { /* 無法解析的更新只保留原始資料 */ }
    }
    return { userId: st.userId, docId: this.docId, text: text.join(''), updates: st.denied.map(e => ({ id: e.id, covers: e.covers, data: b64(e.data), at: e.at })) };
  }

  // 另存為衝突副本（不合併進目前的文件）；伺服器依當下的成員身分檢查，確認後才移除本機草稿
  saveDeniedAsCopy() {
    const st = this.storage;
    if (!st.denied.length) return null;
    const d = this.deniedDraft();
    const copy = { copyId: uuid(), basedEpoch: null, state: b64(Y.mergeUpdates(st.denied.map(e => e.data))), json: JSON.stringify({ kind: 'denied_draft', text: d.text }) };
    st.unackedCopies.push(copy);
    st.denied = [];
    this.touch();
    this.emit('conflict_copy_sent', { ...copy, kind: 'denied' });
    this.raw({ t: 'conflict_copy', ...copy });
    return copy.copyId;
  }

  discardDenied() {
    if (!this.storage.denied.length) return;
    this.storage.denied = [];
    this.touch();
  }

  // ---- 編輯操作（Node 測試用；瀏覽器中由編輯器直接修改 ydoc） ----
  // 等待衝突副本確認期間，編輯器為唯讀（避免這段時間的輸入被捨棄）
  assertEditable() {
    if (this.awaitingOfflineCopy) throw new Error('read-only while saving conflict copy');
    if (this.accessDenied) throw new Error('read-only: access denied');
  }
  isReadOnly() { return !!this.awaitingOfflineCopy || !!this.blocked || !!this.accessDenied; }
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

  // 存版：manual=true 為介面的「存一版」（reason='manual'），否則為 M1 的按需存版（reason='auto'）。
  // 回傳伺服器的 version_ok（已建立，或同一個版本 ID 重送）或 version_error（版本 ID 與其他頁面的版本衝突，M2-c B1-P0）
  makeVersion(versionId, { manual = false } = {}) {
    return new Promise(res => {
      const h = m => { if (m.versionId === versionId) { this.off('version_ok', h); this.off('version_error', h); res(m); } };
      this.on('version_ok', h);
      this.on('version_error', h);
      this.raw({ t: 'make_version', versionId, ...(manual ? { manual: true } : {}) });
    });
  }

  // ---- 登出與本機草稿 ----
  clearStorage() {
    for (const k of Object.keys(this.storage)) delete this.storage[k];
    this.storage.pending = [];
    this.storage.docUpdates = [];
    this.storage.pendingRestores = [];
    this.storage.unackedCopies = [];
    this.storage.denied = [];
    this.storage.knownEpoch = null;
  }

  hasUnsynced() {
    const st = this.storage;
    return st.pending.length > 0 || st.unackedCopies.length > 0 || !!st.offlineCopy || st.denied.length > 0;
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
