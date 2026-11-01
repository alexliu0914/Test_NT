# M1 驗證證據

## 交付版本

- **交付提交：5f7bd0404496117d5f0dde491850bd28239359fe**（本目錄最上層的結果都是這個提交，各 summary.json 的 `dirty: false`）
- 提交關係（由舊到新）：
  1. `a8b1067`：最後一個程式缺陷修正（F-M1-05）
  2. `a19980b`：只新增 `app/evidence/m1/`（a8b1067 的證據）
  3. `5f7bd04`：Windows 相容修正（`collab/server.mjs` 改讀 `--port` 參數、`package.json` 的 collab 指令、README、.env.example）
  4. 之後的提交只新增或搬移 `app/evidence/` 內的檔案，不改程式
- 因為 5f7bd04 改了協作伺服器，交付版本另外重跑完整輪數與全部變異，不沿用 a8b1067 的結果。

## 交付版本的結果（5f7bd04）

- CI 完整輪數（workflow_dispatch, full=true）：https://github.com/alexliu0914/Test_NT/actions/runs/41264281156
  2026-11-01 02:13–03:08 UTC，結論 success；17 個步驟全部 success（執行器自我測試、M1 案例、核心 M0-01～11＋M0-17、瀏覽器 BR-01～04、npm audit、變異測試 26 項）。
- CI 推送時的較少輪數：https://github.com/alexliu0914/Test_NT/actions/runs/41206991000（success）
- 本機完整輪數（本目錄）：34 個案例、1,523 輪，0 失敗；變異 26/26；執行器自我測試 12/12。
  - `m1/`：MIG-01、AUTH-01～07、SEC-01～03／05／06、PAGE-01～05（PAGE-05 60 輪）
  - `core/`：M0-01～11、M0-17
  - `browser/`：BR-01～04（BR-01／02／04 各 20 輪，BR-03 5 輪）
  - `mutations.json`、`runner-selftest.json`
- 需求方試用：`TRIAL.md`（2026-11-01，Windows，7 個步驟全部通過）

## 先前版本的結果（a8b1067，保留供對照）

- `a8b1067/`：同樣 34 個案例、1,523 輪，0 失敗；變異 26/26
- CI：https://github.com/alexliu0914/Test_NT/actions/runs/41195447048（success）
