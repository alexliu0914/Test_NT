# M1 需求方試用紀錄

- 日期：2026-11-01（Asia/Taipei）
- 試用者：需求方本人
- 環境：Windows 11、PowerShell、Docker Desktop（PostgreSQL 16.15 容器）；網頁與協作伺服器以 `npm run dev`、`npm run collab` 在本機執行；兩個帳號分別在兩個瀏覽器視窗
- 程式版本：5f7bd04（含 Windows 相容修正）
- 步驟：M1 驗收報告「需求方試用」一節的 7 個步驟
  1. 管理者登入並設定兩步驟驗證
  2. 建立邀請連結
  3. 第二個帳號以邀請連結建立帳號並設定兩步驟驗證
  4. 兩人同時操作頁面樹
  5. 兩人同時編輯同一頁（含新頁面）
  6. 登出再登入需密碼＋驗證碼；錯誤密碼訊息不透露帳號是否存在
  7. 從另一個登入撤銷裝置，被撤銷的一邊立即斷線
- 結果：7 個步驟全部通過（需求方回報「試用步驟 測試全通過」）
- 試用準備時發現並修正：`npm run collab` 原本的 POSIX 環境變數寫法在 PowerShell 無法執行；說明中的 `openssl`、`createdb` 在 Windows 上通常沒有。修正於 5f7bd04。
- 未涵蓋：手機實機（Android Chrome、iOS Safari）、VMware 等虛擬機環境、跨網路連線；這些不在 M1 驗收範圍。
