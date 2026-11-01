#!/usr/bin/env python3
"""M1 變異測試：在程式複本中植入已知缺陷，相關測試必須抓到（任一輪失敗即算抓到）。
- MUT-1～8：M0 的協作核心缺陷，移植到 M1 的協作伺服器與用戶端
- MUT-A*：認證與安全；MUT-P*：頁面樹；MUT-B*：瀏覽器端
改到 Next.js 會用到的程式（src/、shared/、migrations/）時，複本會重新建置。
用法：python3 test/mutations.py [編號 ...]
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
    ('MUT-P4', '頁面變動沒有推送', 'migrations/0001_triggers.sql',
     "  PERFORM pg_notify('pages_changed', COALESCE(NEW.workspace_id, OLD.workspace_id)::text);", "  NULL;", ['PAGE-01=1']),
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
     "extras.filter(e => isMine(e._item.id.client))", "extras.filter(() => true)", ['BR-05=7']),
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


argv = sys.argv[1:]
stage = None
if '--stage' in argv:
    i = argv.index('--stage'); stage = argv[i + 1]; argv = argv[:i] + argv[i + 2:]
only = argv
results = []
not_applicable = []
if stage:
    man = json.load(open(os.path.join(ROOT, 'test', 'manifest.json'), encoding='utf8'))
    base = json.load(open(os.path.join(ROOT, 'test', 'm1-baseline.json'), encoding='utf8'))
    mstage = {m['id']: m['stage'] for m in man['mutants']}
    defined = {m[0] for m in MUTANTS}
    errs = [f'M1 基線變異被移除或改階段：{x}' for x in base['mutants'] if mstage.get(x) != 'm1' or x not in defined]
    if stage not in man['stages']:
        errs.append('未知的階段：' + stage)
    if errs:
        print('manifest 未通過 M1 基線檢查，拒絕執行：' + '；'.join(errs)); sys.exit(1)
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
