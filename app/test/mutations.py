#!/usr/bin/env python3
"""M1 變異測試：在程式複本中植入已知缺陷，相關測試必須抓到（任一輪失敗即算抓到）。
- MUT-1～8：M0 的協作核心缺陷，移植到 M1 的協作伺服器與用戶端
- MUT-A*：認證與安全；MUT-P*：頁面樹；MUT-B*：瀏覽器端；MUT-C*：編輯器；MUT-S*：空間與權限（M2-s）；MUT-C1～C3、C8：協作游標與儲存狀態（M2-b）；MUT-C9、C10：兩人貼到同一個空白行（M2-b，F-M2-08）；MUT-F09：改區塊類型時補救同時輸入的字（M2-b，F-M2-09）；MUT-F10：復原只改類型的那一步（M2-b，F-M2-10）；MUT-F12：開發模式的復原管理器（M2-c，F-M2-12）
改到 Next.js 會用到的程式（src/、shared/、migrations/）時，複本會重新建置。
用法：python3 test/mutations.py [編號 ...]
      python3 test/mutations.py --check [--manifest 路徑]   只檢查 manifest 與變異定義（自我測試用）
      python3 test/mutations.py --stage m2-a   依 test/manifest.json 執行該階段（含之前）的全部變異；
                                                之後階段的記為 NOT_APPLICABLE_NOT_IMPLEMENTED（不算抓到）"""
import json, os, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 與專案在同一個檔案系統，node_modules 以硬連結複製（Turbopack 不接受指向專案外的符號連結）
WORK = os.path.join(os.path.dirname(ROOT), '.m1-mutants')

MUTANTS = [
    # ---- M0 協作核心（同 M0 的植入方式） ----
    ('MUT-1', '提交前就確認並廣播', 'collab/server.mjs',
     "  if (items.length === 0) return;\n",
     "  if (items.length === 0) return;\n  for (const it of items) { send(it.conn, { t: 'ack', ids: [it.updateId, ...(it.covers || [])], seq: room.seq }); for (const o of room.conns) if (o !== it.conn) send(o, { t: 'remote', data: b64(it.data), seq: room.seq }); }\n",
     ['M0-01=15', 'M0-02=6']),
    ('MUT-2', '移除 update_id 去重', 'collab/server.mjs',
     "        if (fresh.length === 0) { it.duplicate = true; continue; }\n", "", ['M0-03=10']),
    ('MUT-3', '衝突副本在套用伺服器狀態之後才保存', 'shared/client.js',
     "      if (!st.offlineCopy) {\n        st.offlineCopy = {",
     "      Y.applyUpdate(this.ydoc, fromB64(m.state), REMOTE);\n      if (!st.offlineCopy) {\n        st.offlineCopy = {", ['M0-06=10', 'BR-01=2']),
    ('MUT-4', '收到任何確認就清空待確認清單', 'shared/client.js',
     "    this.storage.pending = this.storage.pending.filter(e => !ids.has(e.id));", "    this.storage.pending = [];", ['M0-01=15', 'M0-03=10']),
    ('MUT-5', '重新連線後不重送待確認項目', 'shared/client.js',
     "    for (const e of st.pending) this.sendUpdate(e);\n", "", ['M0-04=10', 'M0-01=15']),
    ('MUT-6', '線上收到還原時不另存衝突副本', 'shared/client.js',
     "      if (st.pending.length > 0) {\n        // 線上收到還原時仍有未確認修改", "      if (false) {\n        // 線上收到還原時仍有未確認修改", ['M0-05=15', 'BR-01=2']),
    ('MUT-7', '伺服器不限制待寫入佇列（無背壓）', 'collab/server.mjs',
     "        if (room.inbox.length >= MAX_INBOX) {", "        if (false) {", ['M0-17=3']),
    ('MUT-8', '用戶端收到 busy 就丟掉該筆修改', 'shared/client.js',
     "    this.emit('busy', m);\n    if (this.busyTimer) return;",
     "    this.emit('busy', m);\n    this.storage.pending = this.storage.pending.filter(e => !m.ids.includes(e.id));\n    if (this.busyTimer) return;", ['M0-17=3']),
    # ---- 認證與安全 ----
    ('MUT-A1', 'API 不檢查兩步驟驗證', 'src/lib/guard.ts',
     "  if (!a.user.twoFactorEnabled) return jsonError(403, 'two_factor_required', '請先完成兩步驟驗證設定');", "", ['AUTH-06=1']),
    ('MUT-A2', '不檢查請求來源（CSRF）', 'src/lib/guard.ts',
     "  if (!MUTATING.has(req.method)) return true;", "  if (MUTATING.size >= 0) return true;", ['SEC-03=1']),
    ('MUT-A3', '登入失敗不鎖定', 'src/lib/lockout.ts',
     "  return byEmail >= MAX_FAILURES || byIp >= MAX_FAILURES;", "  return byEmail > 1e9 && byIp > 1e9;", ['SEC-01=1']),
    ('MUT-A4', '公開註冊端點沒有關閉', 'src/lib/auth.ts',
     "    disableSignUp: true,", "    disableSignUp: false,", ['AUTH-03=1']),
    ('MUT-A5', '邀請可重複使用', 'src/lib/accounts.ts',
     "where token_hash = $1 and used_at is null and expires_at > now() returning id, email`", "where token_hash = $1 returning id, email`", ['AUTH-04=1']),
    ('MUT-A6', '協作伺服器不檢查兩步驟驗證', 'collab/server.mjs',
     "      if (!s.tfa) return ws.close(4001, 'two-factor required');\n", "", ['AUTH-06=1']),
    ('MUT-A7', '協作憑證不檢查頁面', 'shared/collab-token.mjs',
     "  if (claims.pid !== pid) return { ok: false, reason: 'wrong_page' };\n", "", ['SEC-06=1']),
    ('MUT-A8', '協作伺服器沒有即時處理撤銷通知（只靠 60 秒複查）', 'collab/server.mjs',
     "      await c.query('listen session_revoked');\n", "", ['SEC-02=2']),
    # ---- 頁面樹 ----
    ('MUT-P1', '移動時不檢查循環', 'src/lib/pages.ts',
     "        if (cyc.rows[0]) throw new PageError(409, 'cycle', '不能把頁面移到自己或自己的子頁面底下');", "", ['PAGE-02=1']),
    ('MUT-P2', '刪除時只刪除該頁、不含子頁面', 'src/lib/pages.ts',
     "         union all select p.id from pages p join sub on p.parent_id = sub.id where p.deleted_at is null)",
     "         union all select p.id from pages p join sub on p.parent_id = sub.id where false)", ['PAGE-03=1']),
    ('MUT-P3', '清理時不看 30 天期限', 'src/lib/pages.ts',
     "and deleted_at < now() - make_interval(days => $2)", "and $2::int is not null", ['PAGE-04=1']),
    ('MUT-P5', '還原時只檢查指定頁面的上層，不檢查整批', 'src/lib/pages.ts',
     "        where c.id = any($1::uuid[]) and p.deleted_at is not null order by c.position, c.id`, [restored]))",
     "        where c.id = $2::uuid and p.deleted_at is not null and c.parent_id <> all($1::uuid[]) order by c.position, c.id`, [restored, id]))", ['PAGE-03=1']),
    # M2-s：遷移 0002 以帶空間 id 的版本取代 0001 的 notify_pages_changed，植入位置改到目前生效的函式（缺陷相同；T-M2-03）
    ('MUT-P4', '頁面變動沒有推送', 'migrations/0002_spaces.sql',
     "CREATE OR REPLACE FUNCTION notify_pages_changed() RETURNS trigger AS $$\nBEGIN\n",
     "CREATE OR REPLACE FUNCTION notify_pages_changed() RETURNS trigger AS $$\nBEGIN\n  RETURN NULL;\n", ['PAGE-01=1']),
    # ---- 瀏覽器端 ----
    ('MUT-B1', '還原時不清空編輯器的 Undo 堆疊', 'src/components/Editor.tsx',
     "url: '', docId: pageId, token: '', userId: user.id, name: user.name, storage, persist: store,",
     "url: '', docId: pageId, token: '', userId: user.id, name: user.name, storage, persist: store, clearUndoOnRestore: false,", ['BR-01=1']),
    ('MUT-B2', 'BlockNote 協作選項未經 withCollaboration 包裝', 'src/components/Editor.tsx',
     "        const editor = BlockNoteEditor.create(withCollaboration({", "        const editor = BlockNoteEditor.create(((o: any) => o)({", ['BR-01=1']),
    ('MUT-B3', '本機尚未寫入完成時不顯示「尚未存到此裝置」', 'shared/client.js',
     "    if (p.some(e => (e.v || 0) > this.persistedVersion) || !this.localPersisted()) return 'unsaved';\n", "", ['BR-02=1']),
    ('MUT-B4', '只檢查同一份文件、不檢查整台裝置的其他帳號草稿', 'src/components/Editor.tsx',
     "        const foreign = await IdbStore.otherUserDrafts(user.id);", "        const foreign: { key: string; value: Record<string, unknown> }[] = [];", ['BR-02=1']),
    ('MUT-B5', '新頁面沒有固定的文件骨架（兩人同時開始輸入時各自建立）', 'shared/initial-doc.js',
     "export const INITIAL_DOC_B64 = 'AQcB", "export const INITIAL_DOC_B64 = 'AAA=';\nexport const UNUSED_B64 = 'AQcB", ['BR-04=4']),
    # ---- M2-a：編輯器（M2 計畫 v0.4 §4.2；MUT-B6、B7 為 F-M2-01 新增） ----
    ('MUT-C6', '貼上時不過濾連結協定', 'shared/paste-sanitize.js',
     "      if (child.hasAttribute('href') && !isSafeHref(child.getAttribute('href'))) child.removeAttribute('href');\n", "", ['SEC-04=1']),
    ('MUT-B6', '同一區塊有多個內容節點時不容許（y-prosemirror 刪除整個區塊）', 'shared/structure-repair.js',
     "  if (pmSchema.__multiContentTolerant) return;\n  const original = pmSchema.node;", "  return;\n  const original = pmSchema.node;", ['BR-05=7']),
    ('MUT-B7', '不檢查作者，每個用戶端都搬移多出來的內容節點', 'shared/structure-repair.js',
     "extras.filter(e => isMine(e._item.id.client))", "extras.filter(() => true)", ["BR-05=14"]),
    # ---- M2-s：空間與權限（M2-s 增修文件「新增變異」；S8、S9 為審核修訂新增） ----
    ('MUT-S1', '頁面樹 API 不依空間過濾', 'src/lib/pages.ts',
     "      where deleted_at is null and space_id in (select space_id from space_members where user_id = $1)\n      order by space_id",
     "      where deleted_at is null and $1::text is not null\n      order by space_id", ['ACL-01=1']),
    ('MUT-S2', '協作憑證不檢查成員身分', 'src/lib/access.ts',
     "`select 1 from pages p join space_members m on m.space_id = p.space_id and m.user_id = $2",
     "`select 1 from pages p join (select $2::text as user_id) m on true", ['ACL-01=1']),
    ('MUT-S3', '協作伺服器建立連線時不檢查成員身分', 'collab/server.mjs',
     "      if (!(await isMember(m.docId.toLowerCase(), s.user_id))) return ws.close(4004, 'page not found');\n", "", ['ACL-01=1']),
    ('MUT-S4', '移除成員時不中斷協作連線', 'collab/server.mjs',
     "        else if (n.channel === 'space_access_changed') onAccessChanged(n.payload);\n", "", ['ACL-02=1']),
    ('MUT-S5', '即時推送發給所有人', 'src/app/api/pages/events/route.ts',
     "        ready.then(() => { if (mine.has(payload)) fire(); });", "        ready.then(() => { fire(); });", ['ACL-01=1']),
    ('MUT-S6', '移動時不檢查目的空間的成員身分', 'src/lib/pages.ts',
     "    if (cross && !(await lockMembership(c, userId, [dst]))) throw", "    if (cross && false) throw", ['ACL-03=3']),
    ('MUT-S7', '非建立者可以管理成員', 'src/lib/spaces.ts',
     "  if (s.owner_id !== userId) throw new AccessError(403, 'owner_only', '只有空間的建立者可以管理成員');\n", "", ['ACL-02=1']),
    ('MUT-S8', '只在連線時檢查成員身分，提交時不重新授權', 'collab/server.mjs',
     "      for (const it of items) it.denied = !auth.allowed.has(it.userId);\n", "      for (const it of items) it.denied = false;\n", ['ACL-02=1']),
    ('MUT-S9', '帳號上限沒有在新增帳號的交易中強制（只在建立邀請時檢查）', 'migrations/0002_spaces.sql',
     "  PERFORM pg_advisory_xact_lock(hashtext('notes:accounts'));\n  SELECT count(*) INTO n FROM \"user\";\n",
     "  n := 0;\n", ['AUTH-08=1']),
    # ---- M2-b：協作游標與儲存狀態（M2 計畫 v0.5 §4.2） ----
    ('MUT-C1', '伺服器接受用戶端自填名字或顏色', 'collab/server.mjs',
     "    const st = { user: { name: conn.userName, color: assignColor(room, conn.userId) } };",
     "    const st = { user: (e.state && e.state.user) || { name: conn.userName, color: assignColor(room, conn.userId) } };", ['COL-04=1']),
    ('MUT-C2', 'awareness 洩漏到不同頁面', 'collab/server.mjs',
     "  for (const other of room.conns) if (other !== from) send(other, { t: 'aw', data });",
     "  for (const other of authed) if (other !== from) send(other, { t: 'aw', data });", ['COL-04=1']),
    ('MUT-C3', '撤銷時不移除游標', 'collab/server.mjs',
     "  if (!room || conn.presenceDropped) return;", "  if (!room || conn.presenceDropped || conn.revoked) return;", ['COL-09=1']),
    ('MUT-C8', '資料庫失敗時仍顯示已儲存', 'shared/save-state.js',
     "  if (!s.unsynced) return 'saved';", "  if (!s.unsynced || s.dbFailing) return 'saved';", ['COL-11=1']),
    # ---- F-M2-08：兩人貼到同一個空白行（M2-b 新增，使用者核准 44 個） ----
    ('MUT-C9', '貼到空白行時沿用那一行的區塊（不建立自己的新區塊）', 'shared/paste-sanitize.js',
     "  if (!target) return doPaste();", "  if (target || !target) return doPaste();", ['COL-01=1']),
    ('MUT-F09', '改區塊類型時不補救另一人同時輸入的字（F-M2-09）', 'collab/server.mjs',
     "        if (!work && mayNeedRescue(room.ydoc, it.data)) {", "        if (!work && false) {", ['COL-01=1']),
    ('MUT-F10', '復原只改了類型的那一步時，照 Yjs 原本的方式刪除新節點（F-M2-10）', 'src/lib/type-undo.ts',
     "    if (!changes || !changes.some(c => editor.getBlock(c.id))) return origUndo();", "    if (!changes || !changes.some(c => editor.getBlock(c.id)) || Date.now() > 0) return origUndo();", ['COL-01=1']),
    ('MUT-C4', '自動存版不看是否有新更新（M2-c B1）', 'collab/server.mjs',
     "      if (last <= snap) {", "      if (last < 0) {", ['VER-01=1']),
    ('MUT-V1', '自動存版只看這次啟動後才開始的計時（重啟後不補存；M2-c B1）', 'collab/server.mjs',
     "      `select id from pages where dirty_since <= now() - make_interval(secs => $1) and deleted_at is null",
     "      `select id from pages where dirty_since <= now() - make_interval(secs => $1) and deleted_at is null and dirty_since >= now() - make_interval(secs => ${process.uptime()})", ['VER-01=1']),
    ('MUT-V2', '還原不在交易內鎖住目標版本（M2-c B2-P0-02）', 'collab/server.mjs',
     "'select state, reason, created_at from page_versions where id=$1 and page_id=$2 for share'",
     "'select state, reason, created_at from page_versions where id=$1 and page_id=$2'", ['VER-01=1']),
    ('MUT-F12', '開發模式（StrictMode 重複掛載）停掉的復原管理器不重新監聽文件（F-M2-12）', 'src/lib/undo-revive.ts',
     "  um.doc.on('afterTransaction', um.afterTransactionHandler);", "  void um.afterTransactionHandler;", ['DEV-01=1']),
    ('MUT-C10', '自己的空白行被別人的貼上換掉時不補回', 'src/lib/empty-line-keeper.ts',
     "  if (!(a.el as unknown as { _item: { deleted: boolean } })._item.deleted) return;", "  if (a.el) return;", ['COL-01=1']),
]

NEEDS_BUILD = ('src/', 'shared/', 'migrations/', 'next.config')


def _ignore(d, names):
    if os.path.abspath(d) == ROOT:
        return [n for n in names if n in ('node_modules', '.next', 'results', 'test-results') or n.endswith('.log')]
    return []


def run(mid, title, path, old, new, cases):
    shutil.rmtree(WORK, ignore_errors=True)
    shutil.copytree(ROOT, WORK, ignore=_ignore, symlinks=True)
    subprocess.run(['cp', '-al', os.path.join(ROOT, 'node_modules'), os.path.join(WORK, 'node_modules')], check=True)
    p = os.path.join(WORK, path)
    src = open(p, encoding='utf8').read()
    if src.count(old) != 1:
        return {'id': mid, 'title': title, 'error': 'patch anchor not found exactly once'}
    open(p, 'w', encoding='utf8').write(src.replace(old, new))
    # 用到 Next.js 的案例（API／瀏覽器）需要以變異後的程式重新建置
    if any(not c.startswith('M0-') for c in cases):
        if path.startswith(NEEDS_BUILD):
            env = {**os.environ, 'COLLAB_PUBLIC_URL': 'ws://127.0.0.1:27601'}
            b = subprocess.run([os.path.join(WORK, 'node_modules/.bin/next'), 'build'], cwd=WORK, env=env, capture_output=True, text=True)
            if b.returncode != 0:
                # 植入的缺陷都設計成可以編譯；建置失敗代表變異測試本身有問題，不算抓到
                return {'id': mid, 'title': title, 'error': 'build failed: ' + (b.stdout + b.stderr)[-400:]}
        else:
            subprocess.run(['cp', '-al', os.path.join(ROOT, '.next'), os.path.join(WORK, '.next')], check=True)
    out = []
    for c in cases:
        try:
            subprocess.run(['node', 'test/run.js', c], cwd=WORK, timeout=1500, capture_output=True)
        except subprocess.TimeoutExpired:
            out.append({'case': c, 'timedOut': True, 'caught': True}); continue
        f = os.path.join(WORK, 'results', c.split('=')[0] + '.json')
        if not os.path.exists(f):
            out.append({'case': c, 'error': 'no result', 'caught': True}); continue
        d = json.load(open(f, encoding='utf8'))
        fails = [x for x in d['iterations'] if not x['pass']]
        out.append({'case': c, 'total': d['total'], 'failed': len(fails), 'caught': len(fails) > 0,
                    'example': fails[0]['fails'][:2] if fails else []})
    return {'id': mid, 'title': title, 'caught': any(o['caught'] for o in out), 'runs': out}


def opt(name):
    global argv
    if name not in argv:
        return None
    i = argv.index(name); v = argv[i + 1]; argv = argv[:i] + argv[i + 2:]
    return v


def manifest_errors(man):
    """變異清單的檢查（與 test/lib/manifest.mjs 的規則一致，另加變異定義與 manifest 的對應）"""
    base = json.load(open(os.path.join(ROOT, 'test', 'm1-baseline.json'), encoding='utf8'))
    acc = json.load(open(os.path.join(ROOT, 'test', 'accepted-baselines.json'), encoding='utf8'))
    ids = [m['id'] for m in man['mutants']]
    mstage = {m['id']: m['stage'] for m in man['mutants']}
    defined_ids = [m[0] for m in MUTANTS]
    defined = set(defined_ids)
    errs = [f'M1 基線變異被移除或改階段：{x}' for x in base['mutants'] if mstage.get(x) != 'm1' or x not in defined]
    for st, b in acc.get('stages', {}).items():
        errs += [f'已驗收階段 {st} 的變異被移除或改階段：{x}' for x in b['mutants'] if mstage.get(x) != st or x not in defined]
    errs += [f'manifest 的變異編號重複：{x}' for x in sorted({x for x in ids if ids.count(x) > 1})]
    errs += [f'變異定義的編號重複：{x}' for x in sorted({x for x in defined_ids if defined_ids.count(x) > 1})]
    errs += [f'變異已定義但沒有登記在 manifest：{x}' for x in defined_ids if x not in mstage]
    errs += [f'變異 {k} 的階段 {v} 不存在' for k, v in mstage.items() if v not in man['stages']]
    return errs


argv = sys.argv[1:]
stage = opt('--stage')
man_path = opt('--manifest') or os.path.join(ROOT, 'test', 'manifest.json')
check_only = '--check' in argv
argv = [a for a in argv if a != '--check']
only = argv
results = []
not_applicable = []
if stage or check_only:
    man = json.load(open(man_path, encoding='utf8'))
    mstage = {m['id']: m['stage'] for m in man['mutants']}
    defined = {m[0] for m in MUTANTS}
    errs = manifest_errors(man)
    if stage and stage not in man['stages']:
        errs.append('未知的階段：' + stage)
    if errs:
        print('manifest 未通過基線檢查（M1 與已驗收階段），拒絕執行：' + '；'.join(errs)); sys.exit(1)
    if check_only:
        print('manifest 檢查通過'); sys.exit(0)
    idx = man['stages'].index(stage)
    active = [k for k, v in mstage.items() if man['stages'].index(v) <= idx]
    not_applicable = [{'id': k, 'stage': v, 'status': 'NOT_APPLICABLE_NOT_IMPLEMENTED'} for k, v in mstage.items() if k not in active]
    for k in active:
        if k not in defined:
            results.append({'id': k, 'title': '', 'error': 'mutant listed in manifest but not defined'})
    only = [k for k in active if k in defined]
for m in MUTANTS:
    if (only or stage) and m[0] not in only:
        continue
    r = run(*m)
    print(json.dumps(r, ensure_ascii=False), flush=True)
    results.append(r)
os.makedirs(os.path.join(ROOT, 'results'), exist_ok=True)
out = os.path.join(ROOT, 'results', 'mutations.json' if (stage or not only) else 'mutations-' + '-'.join(only) + '.json')
json.dump(results if not stage else {'stage': stage, 'results': results, 'notApplicable': not_applicable},
          open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
shutil.rmtree(WORK, ignore_errors=True)
missed = [r['id'] for r in results if not r.get('caught')]
if os.environ.get('GITHUB_ACTIONS'):
    for r in results:
        if not r.get('caught'):
            print('::error title=m1-mutations::%s %s not caught %s' % (r['id'], r['title'], r.get('error', '')))
print('mutations caught: %d/%d' % (len(results) - len(missed), len(results)) + (' missed=' + ','.join(missed) if missed else '')
      + (' NOT_APPLICABLE_NOT_IMPLEMENTED=' + ','.join(x['id'] for x in not_applicable) if not_applicable else ''))
sys.exit(1 if missed or not results else 0)
