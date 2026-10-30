# M0-B CI 證據

- 程式提交：dbb8197235ed1eadc90e3d00f3b619f09466a7aa
- 完整輪數（workflow_dispatch, full=true）：https://github.com/alexliu0914/Test_NT/actions/runs/41114426385
  2026-10-30 19:20–20:01 UTC，結論 success；15 個步驟全部 success（執行器自我測試、核心 M0-01～11＋M0-17、瀏覽器 BR-01／BR-02 各 20 輪、M0-12～16、變異測試 12 項）。
  結果檔為該次執行的 artifact `m0-results-dbb8197…`。
- 手機測試頁打包與冒煙測試：.github/workflows/m0-15-page.yml，輸出在 build/m0-15 分支。

`local/` 是同一提交在開發環境的完整執行結果（summary 的 `dirty: false`）。
