# M1 驗證證據

- 程式提交：a8b10670d3bb96dedf35a05bb01af24eccb4ed37
- CI 完整輪數（workflow_dispatch, full=true）：https://github.com/alexliu0914/Test_NT/actions/runs/41195447048
  2026-10-31 11:06–12:02 UTC，結論 success；17 個步驟全部 success（執行器自我測試、M1 案例、核心 M0-01～11＋M0-17、瀏覽器 BR-01～04、npm audit、變異測試 26 項）。
- 本目錄是同一提交在開發環境的完整執行結果（各 summary.json 的 `dirty: false`）：
  - `m1/`：MIG-01、AUTH-01～07、SEC-01～03／05／06、PAGE-01～05（PAGE-05 60 輪）
  - `core/`：M0-01～11、M0-17（移植到 M1 的協作伺服器與用戶端）
  - `browser/`：BR-01～04（BR-01／02／04 各 20 輪，BR-03 5 輪）
  - `mutations.json`：26 個植入缺陷全部被抓到
  - `runner-selftest.json`：執行器自我測試
- 合計 34 個案例、1,523 輪，0 失敗。
