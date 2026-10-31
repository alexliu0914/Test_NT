# 筆記平台（M1 基礎平台）

自架、兩人使用的協作筆記平台。M1 交付認證、頁面樹與垃圾桶，並把 M0 驗證過的協作核心移植成正式服務。

## 架構

| 部分 | 位置 | 說明 |
| --- | --- | --- |
| 網頁與 API | `src/`（Next.js 16、App Router） | 登入、兩步驟驗證、邀請、設定、頁面樹、編輯器頁面；API 在 `src/app/api/` |
| 認證 | `src/lib/auth.ts` | Better Auth 1.7（帳號密碼＋TOTP 外掛）；公開註冊關閉 |
| 資料庫 | `src/lib/schema.ts`、`migrations/` | Drizzle ORM；認證資料表由 Better Auth 官方 CLI 產生；每個遷移都有 `migrations/down/` 回滾檔 |
| 協作伺服器 | `collab/server.mjs` | 由 M0 原型移植（提交後才確認與廣播、update_id 去重、還原、衝突副本、背壓）；改用 5 分鐘協作憑證與正式 session |
| 共用程式 | `shared/` | 協作用戶端、文件模型、BlockNote 結構、IndexedDB 草稿、協作憑證（Node 測試與瀏覽器共用） |
| 測試 | `test/` | 執行器與 M0 相同規則；案例清單見下 |

## 本機開發

```bash
cd app
cp .env.example .env          # 填入 BETTER_AUTH_SECRET、COLLAB_SECRET（各執行一次下一行，產生兩組不同的值）
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
docker compose -f docker-compose.test.yml up -d --wait
docker compose -f docker-compose.test.yml exec postgres createdb -U postgres notes_dev
npm ci
npm run db:migrate
npm run admin:create -- --email you@example.com --name 你的名字     # 建立第一個管理者與工作區
npm run dev                    # 網頁 http://localhost:3000
npm run collab                 # 協作伺服器 ws://localhost:3001（另開一個終端機）
```

第一次登入必須設定兩步驟驗證；之後的帳號由管理者在「設定 → 邀請成員」建立邀請連結（72 小時、只能用一次）。

Windows（PowerShell）也適用以上指令；需先啟動 Docker Desktop。

## 測試

```bash
cd app
export PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres
bash test/setup-test-db.sh                         # 建立 notes_test（只會對 *_test 資料庫執行）
COLLAB_PUBLIC_URL=ws://127.0.0.1:27601 npx next build
npx playwright install --with-deps chromium
node test/runner-selftest.mjs                      # 執行器自我測試（12 項）
node test/run.js MIG-01=3 AUTH-01=10 SEC-02=20 PAGE-05=60 M0-01=100 BR-01=20 BR-04=20 ...
python3 test/mutations.py                          # 26 個植入缺陷都必須被抓到
```

| 編號 | 內容 |
| --- | --- |
| MIG-01 | 每個遷移回滾後重新套用，結構完全相同；全部回滾後沒有殘留 |
| AUTH-01～07 | 登入、相同的錯誤訊息、不能未經邀請註冊、邀請一次有效與過期、TOTP 與備援碼、未設定兩步驟驗證不能使用、密碼規則 |
| SEC-01／02／03／05／06 | 登入失敗鎖定、撤銷其他裝置（含協作連線 2 秒內中斷）、跨站請求、未登入的每個 API、協作憑證竄改／過期／錯頁／撤銷 |
| PAGE-01～05 | 對方 2 秒內看到變更、不能移到自己的子頁面、整批刪除與還原、30 天永久刪除、兩人隨機操作的不變量 |
| M0-01～11、M0-17 | M0 協作核心測試，改在正式協作伺服器與正式 session 上執行 |
| BR-01～04 | 真正的 Chromium：兩人編輯與還原、IndexedDB（含正式登入撤銷、不同帳號）、正式介面流程（邀請→兩步驟驗證→頁面樹）、兩人同時開始編輯新頁面 |

瀏覽器測試的網頁固定在 27600、協作伺服器在 27601；網頁的 CSP 在建置時寫入協作網址，所以建置時要設定 `COLLAB_PUBLIC_URL=ws://127.0.0.1:27601`。

## 尚未包含（後續里程碑）

- 協作游標、版本歷史介面、儲存狀態的完整設計（M2）
- 附件、音檔上傳與 R2（M3）；PAGE-04 的附件清理部分隨 M3 驗證
- 搜尋、匯出與匯回（M4）
- 正式部署：Caddy、Tailscale、CSP nonce、秘密掃描、備份（M5）
