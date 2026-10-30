# M0 協作核心原型（M0-A＋M0-B）

目的：以故障注入證明「已儲存的內容不會遺失、版本還原結果一致」，作為是否進入 M1 的依據。這不是產品程式碼。

- **M0-A**：Node.js 用戶端＋簡化文件模型，M0-01～11 核心故障注入、M0-12～16 最小可行性。
- **M0-B**：真正的 BlockNote 編輯器在 Chromium 中，經自建協作伺服器（y-protocols 架構決策）寫入 PostgreSQL，IndexedDB 草稿；新增背壓測試 M0-17、瀏覽器端到端 BR-01（GATE-02）、IndexedDB BR-02（GATE-03）。

## 內容

| 路徑 | 說明 |
| --- | --- |
| `src/server.js` | 協作伺服器：每份文件一條佇列；提交資料庫後才廣播與確認；update_id（用戶端 UUID）去重；還原、衝突副本、撤銷登入、背壓（`MAX_INBOX`）、`/health`、匯出、測試頁 |
| `src/client.js` | 用戶端（Node 測試與瀏覽器共用）：待確認清單、本機持久化、儲存狀態、衝突副本、還原時清空 Undo、背壓合併重送、登出流程 |
| `src/blocknote-schema.js` | BlockNote 結構（預設區塊＋自訂音檔區塊 `appAudio`） |
| `src/export.js` | 完整匯出（區塊 JSON＋Yjs 狀態＋Markdown）與匯回 |
| `web/` | 瀏覽器測試頁（BlockNote＋IndexedDB），`scripts/build-web.sh` 打包到 `web/dist/` |
| `test/run.js` | 測試執行器：任何失敗、中止、未知案例、輪數不足或結果檔缺失 → 退出碼 1；寫出 `results/summary.json`（提交 SHA、環境版本、指令、退出碼） |
| `test/runner-selftest.mjs` | 執行器自我測試：刻意失敗、拋例外、沒有結果檔、非測試資料庫都必須回報失敗 |
| `test/testdb.js`、`test/setup-test-db.sh` | 測試資料庫防護：名稱必須以 `_test` 結尾、含標記資料表、UTF-8，否則拒絕執行 |
| `test/cases.js` | M0-01～11、M0-17（Node.js 用戶端） |
| `test/browser/` | BR-01、BR-02（Playwright＋Chromium，持久化設定檔） |
| `test/mutations.py` | 變異測試：植入 12 個已知缺陷，全部必須被抓到 |
| `feasibility/` | M0-12～16 最小可行性 |
| `evidence/` | 各次正式執行的結果（含種子） |
| `FAILURES.md` | 發現的缺陷、根因、修正與重新驗證 |

## 重現

需求：Node.js 22.23.4、PostgreSQL 16（LC_CTYPE 為 C.UTF-8）、Python 3、Docker（或自備 PostgreSQL）。所有版本固定：`package-lock.json`；Playwright 1.63.0、esbuild 0.28.2（不在 lockfile，以下列指令安裝固定版本）。

```bash
cd prototype
docker compose -f docker-compose.test.yml up -d --wait
export PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres
export DATABASE_URL=postgres://postgres@127.0.0.1:54329/m0_test
bash test/setup-test-db.sh                      # 建立 m0_test（只會對 *_test 資料庫執行）
npm ci
npm install --no-save --ignore-scripts playwright@1.63.0 esbuild@0.28.2
npx playwright install --with-deps chromium
ESBUILD=node_modules/.bin/esbuild bash scripts/build-web.sh

node test/runner-selftest.mjs                   # 執行器自我測試（8 項）
npm run test:core                               # M0-01～11、M0-17 完整輪數
npm run test:browser                            # BR-01、BR-02 各 20 輪
for f in feasibility/m0-1[2346]*.mjs; do node "$f" || exit 1; done
ESBUILD=node_modules/.bin/esbuild python3 test/mutations.py
```

每個指令失敗時退出碼都不是 0。`results/summary.json` 記錄這次執行的提交 SHA、是否有未提交的修改、Node／PostgreSQL／套件／Chromium 版本、完整指令與各案例結果。GitHub Actions（`.github/workflows/m0.yml`）在每次推送時以較少輪數執行全部步驟，手動觸發時執行完整輪數；結果上傳為 artifact。

失敗的輪次會記錄種子；以相同種子重跑時操作順序相同，但網路與行程排程的時間點不保證相同。

## 測試清單

| 編號 | 內容 |
| --- | --- |
| M0-01～11 | 見計畫書 v0.3 第 9 節（儲存確認、伺服器當機、重送去重、離線重連、還原與編輯並行、離線還原衝突副本、還原後 Undo、並行還原、還原時重啟、登出／換帳號、撤銷登入） |
| M0-17 | 資料庫失效 1～3 秒＋佇列上限 25：佇列有界、回覆 busy、`/health` 顯示 `dbDownSince`、恢復後零遺失、失效期間不顯示「已儲存」 |
| BR-01 | 兩個 Chromium 以鍵盤（含中文）編輯 → 資料庫提交 → 伺服器 kill -9 重啟（停機時存本機） → 建立版本 → 一方輸入時另一方還原（線上衝突副本） → 還原後 Undo（他人還原、自己還原；Undo 堆疊確實清空、內容等於還原目標） → 離線修改＋還原（離線衝突副本、頁面重新載入） → 音檔區塊播放來源 → 完整匯出與匯回 |
| BR-02 | IndexedDB：修改後立刻關閉分頁、輸入中 SIGKILL 整個瀏覽器、離線修改後關閉重開、未同步時被撤銷後同帳號重新登入、另一帳號在同裝置（封鎖、下載、確認後捨棄、不會以新帳號送出）、本機寫入變慢時狀態必須是「尚未存到本機」 |

判定原則：只要畫面顯示的不是「尚未存到本機」，之後關閉分頁或強制終止瀏覽器，內容都必須還在並同步進資料庫。

## 與正式版的差異

- 協定以 JSON＋base64 傳輸；正式版改為二進位。
- 測試頁直接以網址參數帶入 session；正式版使用 Better Auth（M1 整合）。
- 音檔以本機檔案代替 R2；Tailscale、Caddy 憑證在部署階段驗證。
- M0-14 中文搜尋使用合成資料；真實語料測試移到搜尋里程碑（M4），門檻在計畫書中註明。
