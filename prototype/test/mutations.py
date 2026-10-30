#!/usr/bin/env python3
"""變異測試：在原型的複本中故意植入已知缺陷，確認 M0 測試能抓到。
每個變異只改一處程式碼，執行與該缺陷相關的測試案例；任一輪失敗即算「抓到」。"""
import json, os, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(tempfile.gettempdir(), 'm0-mutants')

MUTANTS = [
    ('MUT-1', '提交前就確認並廣播', 'src/server.js',
     "  if (items.length === 0) return;\n",
     "  if (items.length === 0) return;\n  for (const it of items) { send(it.conn, { t: 'ack', ids: [it.updateId, ...(it.covers || [])], seq: room.seq }); for (const o of room.conns) if (o !== it.conn) send(o, { t: 'remote', data: b64(it.data), seq: room.seq }); }\n",
     ['M0-01=15', 'M0-02=6']),
    ('MUT-2', '移除 update_id 去重', 'src/server.js',
     "        if (fresh.length === 0) { it.duplicate = true; continue; }\n",
     "",
     ['M0-03=10']),
    ('MUT-3', '衝突副本在套用伺服器狀態之後才保存', 'src/client.js',
     "      if (!st.offlineCopy) {\n        st.offlineCopy = {",
     "      Y.applyUpdate(this.ydoc, fromB64(m.state), REMOTE);\n      if (!st.offlineCopy) {\n        st.offlineCopy = {",
     ['M0-06=10', 'BR-01=2']),
    ('MUT-4', '收到任何確認就清空待確認清單', 'src/client.js',
     "    this.storage.pending = this.storage.pending.filter(e => !ids.has(e.id));",
     "    this.storage.pending = [];",
     ['M0-01=15', 'M0-03=10']),
    ('MUT-5', '重新連線後不重送待確認項目（依賴 Yjs 差異同步）', 'src/client.js',
     "    for (const e of st.pending) this.sendUpdate(e);\n",
     "",
     ['M0-04=10', 'M0-01=15']),
    ('MUT-6', '線上收到還原時不另存衝突副本', 'src/client.js',
     "      if (st.pending.length > 0) {\n        // 線上收到還原時仍有未確認修改",
     "      if (false) {\n        // 線上收到還原時仍有未確認修改",
     ['M0-05=15', 'BR-01=2']),
    ('MUT-7', '伺服器不限制待寫入佇列（無背壓）', 'src/server.js',
     "        if (room.inbox.length >= MAX_INBOX) {",
     "        if (false) {",
     ['M0-17=3']),
    ('MUT-8', '用戶端收到 busy 就丟掉該筆修改', 'src/client.js',
     "    this.emit('busy', m);\n    if (this.busyTimer) return;",
     "    this.emit('busy', m);\n    this.storage.pending = this.storage.pending.filter(e => !m.ids.includes(e.id));\n    if (this.busyTimer) return;",
     ['M0-17=3']),
    # ---- 瀏覽器整合（真正的 BlockNote＋Chromium＋IndexedDB） ----
    ('MUT-B1', '還原時不清空編輯器的 Undo 堆疊', 'web/app.js',
     "storage, persist: store, describe: describeDoc });",
     "storage, persist: store, describe: describeDoc, clearUndoOnRestore: false });",
     ['BR-01=2']),
    ('MUT-B2', 'BlockNote 協作選項未經 withCollaboration 包裝', 'web/app.js',
     "  editor = BlockNoteEditor.create(withCollaboration({",
     "  editor = BlockNoteEditor.create(((o) => o)({",
     ['BR-01=1']),
    ('MUT-B3', '本機尚未寫入完成時不顯示「尚未存到本機」', 'src/client.js',
     "    if (p.some(e => (e.v || 0) > this.persistedVersion) || !this.localPersisted()) return 'unsaved';\n",
     "",
     ['BR-02=2']),
    ('MUT-B4', '只檢查同一份文件、不檢查整台裝置的其他帳號草稿', 'web/app.js',
     "const foreign = await IdbStore.otherUserDrafts(user);",
     "const foreign = [];",
     ['BR-02=2']),
]

def _ignore(d, names):
    # 只略過最上層的產物與 web/dist；node_modules 以符號連結共用（變異只改專案自己的程式碼）
    if os.path.abspath(d) == ROOT:
        return [n for n in names if n in ('feasibility', 'evidence', '.git', 'node_modules') or n.startswith('results') or n.endswith('.log')]
    if os.path.abspath(d) == os.path.join(ROOT, 'web'):
        return [n for n in names if n == 'dist']
    return []

def run(mid, title, path, old, new, cases):
    shutil.rmtree(WORK, ignore_errors=True)
    shutil.copytree(ROOT, WORK, ignore=_ignore, symlinks=True)
    os.symlink(os.path.join(ROOT, 'node_modules'), os.path.join(WORK, 'node_modules'))
    p = os.path.join(WORK, path)
    src = open(p, encoding='utf8').read()
    if src.count(old) != 1:
        return {'id': mid, 'title': title, 'error': 'patch anchor not found exactly once'}
    open(p, 'w', encoding='utf8').write(src.replace(old, new))
    out = []
    # 瀏覽器案例：以變異後的程式碼重新打包測試頁
    if any(c.startswith('BR-') for c in cases):
        b = subprocess.run(['bash', 'scripts/build-web.sh'], cwd=WORK, capture_output=True, text=True)
        if b.returncode != 0:
            return {'id': mid, 'title': title, 'error': 'web build failed: ' + b.stderr[-300:]}
    for c in cases:
        try:
            subprocess.run(['node', 'test/run.js', c], cwd=WORK, timeout=900, capture_output=True)
        except subprocess.TimeoutExpired:
            out.append({'case': c, 'timedOut': True, 'caught': True})
            continue
        f = os.path.join(WORK, 'results', c.split('=')[0] + '.json')
        if not os.path.exists(f):
            out.append({'case': c, 'error': 'no result', 'caught': True}); continue
        d = json.load(open(f, encoding='utf8'))
        fails = [x for x in d['iterations'] if not x['pass']]
        out.append({'case': c, 'total': d['total'], 'failed': len(fails), 'caught': len(fails) > 0,
                    'example': fails[0]['fails'][:2] if fails else []})
    return {'id': mid, 'title': title, 'caught': any(o['caught'] for o in out), 'runs': out}

only = sys.argv[1:]
results = []
for m in MUTANTS:
    if only and m[0] not in only: continue
    r = run(*m)
    print(json.dumps(r, ensure_ascii=False), flush=True)
    results.append(r)
os.makedirs(os.path.join(ROOT, 'results-feas'), exist_ok=True)
out = os.path.join(ROOT, 'results-feas', 'mutations.json' if not only else 'mutations-' + '-'.join(only) + '.json')
json.dump(results, open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
shutil.rmtree(WORK, ignore_errors=True)
missed = [r['id'] for r in results if not r.get('caught')]
if os.environ.get('GITHUB_ACTIONS'):
    for r in results:
        if not r.get('caught'):
            print('::error title=m0-mutations::%s %s not caught %s' % (r['id'], r['title'], r.get('error', '')))
print('mutations caught: %d/%d' % (len(results) - len(missed), len(results)) + (' missed=' + ','.join(missed) if missed else ''))
sys.exit(1 if missed or not results else 0)
