'use client';
// 頁面編輯器：BlockNote（正式 UI）＋ 協作用戶端（M0 驗證過的協定）＋ IndexedDB 草稿
// M1 範圍：沿用 M0 的儲存、離線、還原與衝突副本行為，改用正式登入與 5 分鐘協作憑證。
// M2-a：繁體中文介面、斜線選單只提供 FR-04 的區塊與頁面連結、所有連結與貼上內容經安全規則檢查（W1、W6）。
// M2-s：失去權限（4005）時不再顯示文件內容，只提供下載自己尚未同步的內容；權限恢復後舊草稿不自動補送，由使用者選擇。
// M2-b：同頁其他人的游標、名字、顏色（伺服器確認的身分）；五種儲存狀態；有尚未同步的修改時關閉分頁提醒。
// F-M2-08：貼到空白行時建立自己的新區塊（paste-sanitize.js），自己的空白行被別人的貼上換掉時補回（empty-line-keeper.ts）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { BlockNoteEditor, filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from '@blocknote/core';
import { dictionary, PAGE_LINK_TITLE } from '@shared/editor-dictionary.js';
import { withCollaboration, yDocToBlocks } from '@blocknote/core/yjs';
import { BlockNoteView } from '@blocknote/mantine';
import { SuggestionMenuController, getDefaultReactSlashMenuItems, FormattingToolbarController, FormattingToolbar, blockTypeSelectItems } from '@blocknote/react';
import PageLinkPicker from './PageLinkPicker';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { useComputedColorScheme } from '@mantine/core';
import { Client } from '@shared/client.js';
import { IdbStore, idbStatus } from '@shared/idb-store.js';
import { makeSchema, FRAGMENT, SLASH_ITEMS } from '@shared/blocknote-schema.js';
import { isSafeHref } from '@shared/link-policy.js';
import { safePasteHandler, sanitizeHTML } from '@shared/paste-sanitize.js';
import { pageRegistry } from '@shared/page-registry.js';
import { tolerateMultiContent, repairByAuthor, ownClientIds, findMultiContent } from '@shared/structure-repair.js';
import { initialDocUpdate } from '@shared/initial-doc.js';
import { setLeaveGuard } from '@/lib/leave-guard';
import { keepEmptyLine } from '@/lib/empty-line-keeper';
import { guardBinding } from '@/lib/binding-guard';
import { installTypeUndo } from '@/lib/type-undo';
import { reviveUndoManager } from '@/lib/undo-revive';
import VersionPanel from './VersionPanel';
import { Button, Group, Text } from '@mantine/core';
import * as Y from 'yjs';

export type SaveState = 'loading' | 'saved' | 'saving' | 'offline' | 'failed' | 'unsaved' | 'readonly' | 'blocked' | 'revoked' | 'page_closed' | 'denied' | 'error';

// 游標：沿用 BlockNote 預設的外觀，另加名字與顏色的屬性（測試與輔助技術用）
function renderCursor(u: { name: string; color: string }) {
  const base = document.createElement('span');
  base.classList.add('bn-collaboration-cursor__base');
  base.dataset.testid = 'remote-cursor';
  base.dataset.name = u.name;
  base.dataset.color = u.color;
  const caret = document.createElement('span');
  caret.setAttribute('contenteditable', 'false');
  caret.classList.add('bn-collaboration-cursor__caret');
  caret.style.backgroundColor = u.color;
  const label = document.createElement('span');
  label.classList.add('bn-collaboration-cursor__label');
  label.style.backgroundColor = u.color;
  label.style.color = 'white';
  label.textContent = u.name;
  caret.appendChild(label);
  base.append('\u2060', caret, '\u2060');
  return base;
}

const schema = makeSchema((fileId: string) => `/api/files/${encodeURIComponent(fileId)}/content`);

type Props = { pageId: string; user: { id: string; name: string }; onStatus: (s: SaveState) => void };

type Ready = { client: InstanceType<typeof Client>; editor: BlockNoteEditor<any, any, any>; store: IdbStore };

export default function Editor(props: Props) {
  const [ready, setReady] = useState<Ready | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [idbBlocked, setIdbBlocked] = useState(false);
  const { pageId, user, onStatus } = props;
  // 草稿資料庫升級（M2-c B3）被其他分頁的舊版程式擋住時提示；其他分頁關閉後自動繼續
  useEffect(() => {
    const f = (st: { blocked: boolean; versionChanged: boolean }) => {
      setIdbBlocked(st.blocked);
      if (st.versionChanged) setFatal('此頁面需要重新整理（本機草稿資料庫已由新版程式更新）。');
    };
    idbStatus.listeners.add(f);
    f(idbStatus);
    return () => { idbStatus.listeners.delete(f); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let client: InstanceType<typeof Client> | null = null;
    (async () => {
      try {
        // M2-c B3：只讀寫這個帳號自己分區的草稿（draft:<帳號>:<頁面>）；其他帳號的草稿不載入、不顯示
        const store = IdbStore.forPage(user.id, pageId);
        const storage = (await store.load()) || {};
        if (cancelled) return;
        const converter = BlockNoteEditor.create({ schema });
        client = new Client({
          url: '', docId: pageId, token: '', userId: user.id, name: user.name, storage, persist: store,
          // 網路中斷但連線沒有關閉時，8 秒內改顯示「離線」並重新連線（M2-b W3）
          livenessMs: 8000,
          describe: (ydoc: unknown) => JSON.stringify(yDocToBlocks(converter, ydoc as never, FRAGMENT)),
          // 每次連線前換新的 5 分鐘協作憑證；401＝登入失效，404＝頁面已不存在
          getToken: async () => {
            const r = await fetch(`/api/pages/${pageId}/collab-token`, { method: 'POST', cache: 'no-store' });
            if (!r.ok) { const e = new Error('collab token ' + r.status) as Error & { status: number }; e.status = r.status; throw e; }
            const j = await r.json();
            client!.url = j.url;
            return j.token;
          },
        });
        // 文件仍是空的（新頁面、這台裝置還沒同步過）：先套用固定的骨架，避免兩人同時開始輸入時各自建立一份（F-M1-05）
        // 結構 ID 與伺服器建立頁面時寫入的完全相同，已存在時套用不會有任何變化
        // F-M2-07：草稿不屬於這個帳號（client.blocked）時不套用
        if (!client.blocked && client.ydoc.getXmlFragment(FRAGMENT).length === 0) Y.applyUpdate(client.ydoc, initialDocUpdate(), 'initial-doc');
        const editor = BlockNoteEditor.create(withCollaboration({
          schema,
          dictionary,
          links: { isValidLink: isSafeHref },
          pasteHandler: safePasteHandler as never,
          collaboration: {
            fragment: client.ydoc.getXmlFragment(FRAGMENT),
            // 名字與顏色以伺服器為準（welcome 告知、轉送時覆蓋）；這裡只是連線前的預設值
            user: { name: user.name, color: '#868e96' },
            provider: { awareness: client.awareness },
            renderCursor,
          },
        }));
        // F-M2-01：兩人同時改同一個區塊的類型時，不讓 y-prosemirror 刪掉整個區塊（修復與暫停編輯在 Bound）
        tolerateMultiContent(editor.pmSchema);
        // 收到伺服器的更新時，在同一個交易中由作者修復（編輯器只會看到修復後的文件）
        const c = client;
        c.repair = (ydoc: Y.Doc) => {
          const mine = ownClientIds(ydoc, c.storage.pending.map((e: { data: Uint8Array }) => e.data));
          return repairByAuthor(ydoc, ydoc.getXmlFragment(FRAGMENT), (id: number) => mine.has(id), () => crypto.randomUUID());
        };
        setReady({ client, editor, store });
      } catch (e) {
        setFatal(String((e as Error).message || e));
      }
    })();
    return () => { cancelled = true; if (client) client.disconnect(); };
  }, [pageId, user.id, user.name]);

  if (fatal) return <div role="alert">編輯器無法啟動：{fatal}</div>;
  if (!ready) return idbBlocked ? <div role="alert" data-testid="idb-blocked" style={{ padding: 24 }}>正在更新本機草稿資料庫，請關閉或重新整理其他開著本站的分頁。</div> : null;
  return <Bound {...props} ready={ready} />;
}

function Bound({ ready, onStatus, user, pageId }: Props & { ready: Ready }) {
  const { client, editor, store } = ready;
  const scheme = useComputedColorScheme('light');
  const viewRef = useRef<HTMLDivElement>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  // 草稿不屬於這個帳號（用戶端防線，M0-10；依帳號分區後正常情況不會發生）
  const deviceBlocked = !!client.blocked;
  const flags = useMemo(() => ({ revoked: false, pageClosed: false, unbound: false, denied: false }), []);
  const [denied, setDenied] = useState(false);
  const [deniedDrafts, setDeniedDrafts] = useState(0);
  const [picker, setPicker] = useState(false);
  const [merging, setMerging] = useState(false);
  // M2-c W4：版本紀錄面板、手動存版
  const [versionsOpen, setVersionsOpen] = useState(false);
  // 訊息帶序號：同樣的文字再出現一次也看得出是新的結果
  const [versionMsg, setVersionMsgState] = useState<{ text: string; n: number } | null>(null);
  const setVersionMsg = (text: string) => setVersionMsgState(v => ({ text, n: (v ? v.n : 0) + 1 }));
  const [savingVersion, setSavingVersion] = useState(false);
  async function saveVersion() {
    if (!client.ready) { setVersionMsg('目前離線，連線後才能存版。'); return; }
    setSavingVersion(true);
    try {
      const r = await Promise.race([
        client.makeVersion(crypto.randomUUID(), { manual: true }),
        new Promise<{ t: string }>(res => setTimeout(() => res({ t: 'timeout' }), 10000)),
      ]) as { t: string };
      setVersionMsg(r.t === 'version_ok' ? '已存一版。' : '存版失敗，請稍後再試。');
    } finally { setSavingVersion(false); }
  }
  const bindingErrors = useMemo<string[]>(() => [], []);
  // F-M2-01：區塊有多個內容節點時，作者立刻搬到新區塊；不是作者就暫停編輯等待，3 秒後仍未修復才自己修復
  useEffect(() => {
    if (deviceBlocked) return;
    const frag = client.ydoc.getXmlFragment(FRAGMENT);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const check = () => {
      if (stopped) return;
      const mine = ownClientIds(client.ydoc, client.storage.pending.map((e: { data: Uint8Array }) => e.data));
      repairByAuthor(client.ydoc, frag, (id: number) => mine.has(id), () => crypto.randomUUID());
      if (findMultiContent(frag).length) {
        setMerging(true);
        timer ||= setTimeout(() => { timer = null; repairByAuthor(client.ydoc, frag, () => true, () => crypto.randomUUID()); check(); }, 3000);
      } else {
        setMerging(false);
        if (timer) { clearTimeout(timer); timer = null; }
      }
    };
    const onTr = (tr: Y.Transaction) => { if (tr.origin === 'remote' || tr.origin === 'load') queueMicrotask(check); };
    client.ydoc.on('afterTransaction', onTr);
    check();
    return () => { stopped = true; client.ydoc.off('afterTransaction', onTr); if (timer) clearTimeout(timer); };
  }, [client, deviceBlocked]);
  // F-M2-08：游標所在的空白行被另一個人的貼上換掉時，補一個空白行給自己（條件見 empty-line-keeper.ts）
  useEffect(() => (deviceBlocked ? undefined : keepEmptyLine(editor, client.ydoc)), [client, editor, deviceBlocked]);
  // 斜線選單：FR-04 允許的區塊＋頁面連結（M2 W1）
  const slashItems = useMemo(() => [
    ...getDefaultReactSlashMenuItems(editor).filter(i => SLASH_ITEMS.includes((i as unknown as { key: string }).key)),
    { key: 'page_link', title: PAGE_LINK_TITLE, subtext: '連到工作區中的另一個頁面', aliases: ['page', 'link', 'yemian', 'lianjie', '頁面', '連結'],
      group: '其他', icon: <span aria-hidden>🔗</span>, onItemClick: () => setPicker(true) },
  ], [editor]);
  // 格式工具列的區塊類型選單：只留段落、標題 1～3、引言、三種清單
  const typeItems = useMemo(() => blockTypeSelectItems(editor).filter(i => {
    const pr = (i.props || {}) as { level?: number; isToggleable?: boolean };
    if (i.type === 'heading') return (pr.level ?? 1) <= 3 && !pr.isToggleable;
    return ['paragraph', 'quote', 'bulletListItem', 'numberedListItem', 'checkListItem'].includes(i.type);
  }), [editor]);

  useEffect(() => {
    if (deviceBlocked) return;
    const view = viewRef.current;
    let untypeUndo: (() => void) | null = null;
    // 防呆（M0-B F-05）：確認編輯器真的綁定到協作文件
    const t = setTimeout(() => {
      flags.unbound = !editor.prosemirrorState.plugins.some(p => typeof (p as unknown as { key: string }).key === 'string' && (p as unknown as { key: string }).key.startsWith('y-sync$'));
      if (flags.unbound) { setReadOnly(true); setBanner('編輯器未連接到協作文件，無法儲存。'); }
      // F-M2-09：繫結套用修改時發生例外就重新完整繪製（避免舊畫面被寫回、把剛收到的修改刪掉）
      if (!flags.unbound) guardBinding(editor, e => { bindingErrors.push(String(e)); if (bindingErrors.length > 20) bindingErrors.shift(); });
      // F-M2-12：開發模式（StrictMode 重複掛載）停掉的復原管理器重新開始監聽文件
      if (!flags.unbound) reviveUndoManager(editor);
      // F-M2-10：只改了區塊類型的那一步，復原／重做時只改類型（不撤銷別人之後的文字）
      if (!flags.unbound && !untypeUndo) untypeUndo = installTypeUndo(editor);
      for (const p of editor.prosemirrorState.plugins) {
        const st = p.getState(editor.prosemirrorState) as { undoManager?: unknown } | undefined;
        if (st && st.undoManager) client.registerUndoManager(st.undoManager);
      }
    }, 0);
    const subs: [string, (...a: any[]) => void][] = [];
    const on = (ev: string, fn: (...a: any[]) => void) => { subs.push([ev, fn]); client.on(ev, fn); };
    on('conflict_copy_sent', ((c: { kind: string }) => { if (c.kind === 'offline') setReadOnly(true); }));
    on('offline_conflict_resolved', (async () => {
      const until = Date.now() + 5000;
      while (!client.localPersisted() && Date.now() < until) await new Promise(r => setTimeout(r, 20));
      location.reload();
    }));
    on('revoked', (() => { flags.revoked = true; setReadOnly(true); setBanner('登入已失效，尚未同步的內容保留在此裝置。請重新登入。'); }));
    on('page_closed', (() => { flags.pageClosed = true; setReadOnly(true); setBanner('無法開啟這個頁面：可能已移到垃圾桶，或你已無法存取。'); }));
    on('access_denied', (() => { flags.denied = true; setReadOnly(true); setDenied(true); }));
    on('denied_drafts', ((n: number) => setDeniedDrafts(n)));
    client.connect();
    void view;
    // 效果重新執行（開發模式的 StrictMode 會刻意執行兩次）時不重複註冊事件
    return () => { clearTimeout(t); if (untypeUndo) untypeUndo(); for (const [ev, fn] of subs) client.off(ev, fn); };
  }, [client, editor, deviceBlocked, flags]);

  useEffect(() => {
    const status = (): SaveState => {
      if (deviceBlocked) return 'blocked';
      if (flags.unbound) return 'error';
      if (flags.revoked) return 'revoked';
      if (flags.pageClosed) return 'page_closed';
      if (flags.denied) return 'denied';
      if (client.isReadOnly()) return 'readonly';
      return client.displayStatus() as SaveState;
    };
    // 狀態變化紀錄（測試用：確認「已儲存」只在所有待確認更新都收到確認後出現）
    const log: { at: number; s: SaveState; pending: number }[] = [];
    const tick = () => {
      const s = status();
      if (!log.length || log[log.length - 1].s !== s) { log.push({ at: Date.now(), s, pending: client.storage.pending.length }); if (log.length > 500) log.shift(); }
      onStatus(s);
    };
    const iv = setInterval(tick, 100);
    tick();
    const unguard = setLeaveGuard({
      unsynced: () => (deviceBlocked || flags.denied ? 0 : client.storage.pending.length + client.storage.unackedCopies.length + (client.storage.offlineCopy ? 1 : 0)),
      waitClean: async (ms: number) => { const until = Date.now() + ms; while (client.hasUnsynced() && Date.now() < until) await new Promise(r => setTimeout(r, 50)); return !client.hasUnsynced() || flags.denied; },
    });
    // 有尚未同步（或尚未寫入本機）的修改時關閉分頁：瀏覽器只允許顯示通用的提醒文字
    const beforeUnload = (e: BeforeUnloadEvent) => { if (!deviceBlocked && !flags.denied && client.hasUnsynced()) e.preventDefault(); };
    addEventListener('beforeunload', beforeUnload);
    // 瀏覽器回報離線／恢復連網：立即改為離線、立即重新連線
    const goOffline = () => client.goOffline();
    const goOnline = () => client.reconnectNow();
    addEventListener('offline', goOffline);
    addEventListener('online', goOnline);
    // 自動化測試用介面
    (window as unknown as { __app: unknown }).__app = {
      client, editor, store, status, statusLog: () => log.slice(),
      peers: () => client.peers(), me: () => client.me, awarenessClientId: () => client.awareness.clientID,
      bindingErrors: () => bindingErrors.slice(),
      blocks: () => editor.document,
      text: () => editor.document.map(b => (Array.isArray(b.content) ? (b.content as { text?: string }[]).map(c => c.text || '').join('') : '')).join('\n'),
      persisted: () => client.localPersisted(),
      // 版本還原介面屬於 M2；M1 的端到端測試直接呼叫協作用戶端
      makeVersion: (id: string) => client.makeVersion(id),
      restoreAndWait: (versionId: string) => new Promise(res => {
        const id = client.restore(versionId);
        const h = (m: { restoreId: string }) => { if (m.restoreId === id) { client.off('restore_result', h); res(m); } };
        client.on('restore_result', h);
      }),
      undoInfo: () => ({ managers: client.extraUndoManagers.size, depth: [...client.extraUndoManagers].reduce((n, um) => n + um.undoStack.length + um.redoStack.length, 0) }),
      // M2-a 安全測試（SEC-04）直接檢查各層：貼上清理、連結規則、頁面標題表
      sanitizeHTML, isSafeHref, pageRegistryLoaded: () => pageRegistry.loaded(),
      // F-M2-01 測試用：目前有多個內容節點的區塊（作者的 clientID）
      multiContent: () => findMultiContent(client.ydoc.getXmlFragment(FRAGMENT)).map(x => ({ id: x.container.getAttribute('id'), extras: x.extras.map((e: { _item: { id: { client: number } } }) => e._item.id.client) })),
      clientId: () => client.ydoc.clientID,
      // M2-s 測試用：失去權限的草稿
      deniedDraft: () => client.deniedDraft(),
      visiblePages: () => pageRegistry.list().map((p: { id: string }) => p.id),
      draftKey: () => store.key,
    };
    return () => { clearInterval(iv); unguard(); removeEventListener('beforeunload', beforeUnload); removeEventListener('offline', goOffline); removeEventListener('online', goOnline); };
  }, [client, editor, store, deviceBlocked, onStatus, flags]);

  if (deviceBlocked) return <NotYourDraft />;
  if (denied) return <AccessDenied client={client} />;
  return (
    <div ref={viewRef}>
      {banner && <div role="status" style={{ padding: '8px 54px', color: 'var(--mantine-color-orange-7)' }}>{banner}</div>}
      {deniedDrafts > 0 && <DeniedDrafts client={client} onDone={() => setDeniedDrafts(0)} />}
      {merging && !banner && <div role="status" data-testid="merging" style={{ padding: '8px 54px', color: 'var(--mantine-color-dimmed)' }}>正在合併另一位使用者同時做的修改…</div>}
      <Group gap="xs" px={54} pb={4} justify="flex-end">
        {versionMsg && <Text size="xs" c="dimmed" role="status" data-testid="version-message" data-n={versionMsg.n}>{versionMsg.text}</Text>}
        <Button size="compact-xs" variant="subtle" data-testid="save-version" loading={savingVersion} disabled={readOnly || merging} onClick={saveVersion}>存一版</Button>
        <Button size="compact-xs" variant="subtle" data-testid="open-versions" onClick={() => setVersionsOpen(true)}>版本紀錄</Button>
      </Group>
      <VersionPanel client={client} pageId={pageId} opened={versionsOpen} onClose={() => setVersionsOpen(false)} onMessage={setVersionMsg} />
      <Presence client={client} />
      <BlockNoteView editor={editor} editable={!readOnly && !merging} theme={scheme === 'dark' ? 'dark' : 'light'} slashMenu={false} formattingToolbar={false}>
        <SuggestionMenuController triggerCharacter="/" getItems={async q => filterSuggestionItems(slashItems as never, q)} />
        <FormattingToolbarController formattingToolbar={() => <FormattingToolbar blockTypeSelectItems={typeItems} />} />
      </BlockNoteView>
      <PageLinkPicker exclude={pageId} opened={picker} onClose={() => setPicker(false)} onPick={id => { setPicker(false); insertOrUpdateBlockForSlashMenu(editor, { type: 'pageLink', props: { pageId: id } } as never); }} />
      <span hidden data-user={user.id} />
    </div>
  );
}

// 同頁在線的其他人（伺服器確認的名字與顏色；同一帳號的多條連線合併顯示）
function Presence({ client }: { client: InstanceType<typeof Client> }) {
  const [peers, setPeers] = useState(() => client.peers());
  useEffect(() => {
    const h = () => setPeers(client.peers());
    client.on('peers', h);
    client.on('disconnected', h);
    return () => { client.off('peers', h); client.off('disconnected', h); };
  }, [client]);
  const people = [...new Map(peers.map(p => [p.name + '|' + p.color, p])).values()];
  if (!people.length) return null;
  return (
    <div data-testid="presence" aria-label="同頁的其他人" style={{ padding: '4px 54px', display: 'flex', gap: 12, fontSize: 13, color: 'var(--mantine-color-dimmed)' }}>
      {people.map(p => (
        <span key={p.name + p.color} data-testid="presence-user" data-name={p.name} data-color={p.color} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: p.color, display: 'inline-block' }} />{p.name}
        </span>
      ))}
    </div>
  );
}

// 這一頁的本機草稿不屬於目前的帳號（用戶端防線）：不顯示、不下載、不送出其內容
function NotYourDraft() {
  return (
    <div role="alert" data-testid="not-your-draft" style={{ padding: 24, maxWidth: 560 }}>
      <p>這一頁在此裝置上的草稿不屬於目前登入的帳號，無法開啟。請改用原本的帳號登入。</p>
    </div>
  );
}

function downloadJson(name: string, data: unknown) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = name;
  a.click();
}

// 失去權限（被移出空間、頁面被移到看不到的空間）：不再顯示文件內容；自己尚未同步的內容可下載
function AccessDenied({ client }: { client: InstanceType<typeof Client> }) {
  const n = client.storage.denied.length;
  return (
    <div role="alert" data-testid="access-denied" style={{ padding: 24, maxWidth: 560 }}>
      <p><b>你已無法存取這個頁面。</b></p>
      {n > 0
        ? <><p>你在失去權限前有尚未同步的內容，只保留在這台裝置上，不會再送出。</p>
          <p><button type="button" onClick={() => downloadJson('unsynced.json', client.deniedDraft())}>下載尚未同步的內容</button></p></>
        : <p>你所有的修改都已儲存。</p>}
    </div>
  );
}

// 權限恢復後：失去權限前留下的草稿不自動補送，由使用者選擇
function DeniedDrafts({ client, onDone }: { client: InstanceType<typeof Client>; onDone: () => void }) {
  return (
    <div role="status" data-testid="denied-drafts" style={{ padding: '8px 54px', color: 'var(--mantine-color-orange-7)' }}>
      你在失去權限前有尚未同步的內容（沒有合併進目前的頁面）。{' '}
      <button type="button" onClick={() => downloadJson('unsynced.json', client.deniedDraft())}>下載</button>{' '}
      <button type="button" onClick={() => { client.saveDeniedAsCopy(); onDone(); }}>另存為衝突副本</button>{' '}
      <button type="button" onClick={() => { client.discardDenied(); onDone(); }}>捨棄</button>
    </div>
  );
}
