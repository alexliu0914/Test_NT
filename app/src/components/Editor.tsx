'use client';
// 頁面編輯器：BlockNote（正式 UI）＋ 協作用戶端（M0 驗證過的協定）＋ IndexedDB 草稿
// M1 範圍：沿用 M0 的儲存、離線、還原與衝突副本行為，改用正式登入與 5 分鐘協作憑證。
// 完整的協作體驗（游標、版本歷史介面等）屬於 M2。
import { useEffect, useMemo, useRef, useState } from 'react';
import { BlockNoteEditor } from '@blocknote/core';
import { withCollaboration, yDocToBlocks } from '@blocknote/core/yjs';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { useComputedColorScheme } from '@mantine/core';
import { Awareness } from 'y-protocols/awareness';
import { Client } from '@shared/client.js';
import { IdbStore } from '@shared/idb-store.js';
import { makeSchema, FRAGMENT } from '@shared/blocknote-schema.js';

export type SaveState = 'loading' | 'saved' | 'saving' | 'failed' | 'unsaved' | 'readonly' | 'blocked' | 'revoked' | 'page_closed' | 'error';

const schema = makeSchema((fileId: string) => `/api/files/${encodeURIComponent(fileId)}/content`);

type Props = { pageId: string; user: { id: string; name: string }; onStatus: (s: SaveState) => void };

type Ready = { client: InstanceType<typeof Client>; editor: BlockNoteEditor<any, any, any>; store: IdbStore; foreign: { key: string; value: Record<string, unknown> }[] };

export default function Editor(props: Props) {
  const [ready, setReady] = useState<Ready | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const { pageId, user, onStatus } = props;

  useEffect(() => {
    let cancelled = false;
    let client: InstanceType<typeof Client> | null = null;
    (async () => {
      try {
        const foreign = await IdbStore.otherUserDrafts(user.id);
        const store = new IdbStore('doc:' + pageId);
        const storage = (await store.load()) || {};
        if (cancelled) return;
        const converter = BlockNoteEditor.create({ schema });
        client = new Client({
          url: '', docId: pageId, token: '', userId: user.id, name: user.name, storage, persist: store,
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
        const editor = BlockNoteEditor.create(withCollaboration({
          schema,
          collaboration: {
            fragment: client.ydoc.getXmlFragment(FRAGMENT),
            user: { name: user.name, color: '#0ca678' },
            provider: { awareness: new Awareness(client.ydoc) },
          },
        }));
        setReady({ client, editor, store, foreign });
      } catch (e) {
        setFatal(String((e as Error).message || e));
      }
    })();
    return () => { cancelled = true; if (client) client.disconnect(); };
  }, [pageId, user.id, user.name]);

  if (fatal) return <div role="alert">編輯器無法啟動：{fatal}</div>;
  if (!ready) return null;
  return <Bound {...props} ready={ready} />;
}

function Bound({ ready, onStatus, user }: Props & { ready: Ready }) {
  const { client, editor, store, foreign } = ready;
  const scheme = useComputedColorScheme('light');
  const viewRef = useRef<HTMLDivElement>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const deviceBlocked = foreign.length > 0 || !!client.blocked;
  const flags = useMemo(() => ({ revoked: false, pageClosed: false, unbound: false }), []);

  useEffect(() => {
    if (deviceBlocked) return;
    const view = viewRef.current;
    // 防呆（M0-B F-05）：確認編輯器真的綁定到協作文件
    const t = setTimeout(() => {
      flags.unbound = !editor.prosemirrorState.plugins.some(p => typeof (p as unknown as { key: string }).key === 'string' && (p as unknown as { key: string }).key.startsWith('y-sync$'));
      if (flags.unbound) { setReadOnly(true); setBanner('編輯器未連接到協作文件，無法儲存。'); }
      for (const p of editor.prosemirrorState.plugins) {
        const st = p.getState(editor.prosemirrorState) as { undoManager?: unknown } | undefined;
        if (st && st.undoManager) client.registerUndoManager(st.undoManager);
      }
    }, 0);
    const on = (ev: string, fn: (...a: any[]) => void) => client.on(ev, fn);
    on('conflict_copy_sent', ((c: { kind: string }) => { if (c.kind === 'offline') setReadOnly(true); }));
    on('offline_conflict_resolved', (async () => {
      const until = Date.now() + 5000;
      while (!client.localPersisted() && Date.now() < until) await new Promise(r => setTimeout(r, 20));
      location.reload();
    }));
    on('revoked', (() => { flags.revoked = true; setReadOnly(true); setBanner('登入已失效，尚未同步的內容保留在此裝置。請重新登入。'); }));
    on('page_closed', (() => { flags.pageClosed = true; setReadOnly(true); setBanner('這個頁面已移到垃圾桶。'); }));
    client.connect();
    void view;
    return () => clearTimeout(t);
  }, [client, editor, deviceBlocked, flags]);

  useEffect(() => {
    const status = (): SaveState => {
      if (deviceBlocked) return 'blocked';
      if (flags.unbound) return 'error';
      if (flags.revoked) return 'revoked';
      if (flags.pageClosed) return 'page_closed';
      if (client.isReadOnly()) return 'readonly';
      return client.saveStatus() as SaveState;
    };
    const iv = setInterval(() => onStatus(status()), 200);
    onStatus(status());
    const beforeUnload = (e: BeforeUnloadEvent) => { if (!deviceBlocked && client.saveStatus() === 'unsaved') e.preventDefault(); };
    addEventListener('beforeunload', beforeUnload);
    // 自動化測試用介面
    (window as unknown as { __app: unknown }).__app = {
      client, editor, store, status,
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
      foreignDrafts: () => describeForeign(foreign),
      discardForeign: async () => { await IdbStore.deleteKeys(foreign.map(f => f.key)); if (client.blocked) await client.discardAndLogout({ confirm: true }); },
    };
    return () => { clearInterval(iv); removeEventListener('beforeunload', beforeUnload); };
  }, [client, editor, store, deviceBlocked, onStatus, flags, foreign]);

  if (deviceBlocked) return <ForeignDrafts foreign={foreign} client={client} />;
  return (
    <div ref={viewRef}>
      {banner && <div role="status" style={{ padding: '8px 54px', color: 'var(--mantine-color-orange-7)' }}>{banner}</div>}
      <BlockNoteView editor={editor} editable={!readOnly} theme={scheme === 'dark' ? 'dark' : 'light'} />
      <span hidden data-user={user.id} />
    </div>
  );
}

// 其他帳號的草稿轉成可讀的區塊 JSON（下載用）
const converterForDrafts = BlockNoteEditor.create({ schema });
function describeForeign(foreign: { key: string; value: Record<string, unknown> }[]) {
  return foreign.map(({ key, value }) => {
    const c = new Client({ url: '', docId: key.slice(4), token: '', userId: String(value.userId), storage: structuredClone(value),
      describe: (ydoc: unknown) => JSON.stringify(yDocToBlocks(converterForDrafts, ydoc as never, FRAGMENT)) });
    return { key, ...c.downloadUnsynced() };
  });
}

// 這台裝置上有其他帳號尚未同步的草稿：先下載或確認後捨棄，才能開始編輯（M0-B F-07）
function ForeignDrafts({ foreign, client }: { foreign: { key: string; value: Record<string, unknown> }[]; client: InstanceType<typeof Client> }) {
  const [confirming, setConfirming] = useState(false);
  function download() {
    const data = JSON.stringify(describeForeign(foreign), null, 1);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = 'drafts.json';
    a.click();
  }
  async function discard() {
    await IdbStore.deleteKeys(foreign.map(f => f.key));
    if (client.blocked) await client.discardAndLogout({ confirm: true });
    location.reload();
  }
  return (
    <div role="alert" style={{ padding: 24, maxWidth: 560 }}>
      <p>這台裝置上有其他帳號尚未同步的草稿（{foreign.length || 1} 份）。請先下載或捨棄，才能在這台裝置上編輯。</p>
      <p><button type="button" onClick={download}>下載草稿</button>{' '}
        {!confirming ? <button type="button" onClick={() => setConfirming(true)}>捨棄草稿</button>
          : <><span>確定捨棄？捨棄後無法復原。</span> <button type="button" onClick={discard}>確定捨棄</button></>}</p>
    </div>
  );
}
