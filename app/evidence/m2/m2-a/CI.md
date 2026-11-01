# M2-a 驗證證據（編輯器）

## 交付版本

- **交付提交：21412934c1cbb732a6b2a63c85ead3ae49eca050**（本目錄最上層的結果都是這個提交；各 summary.json 的 `tested_sha` 相同、`dirty: false`）
- 提交關係（由舊到新）：
  1. `b702236`：測試分段啟用清單（manifest、M1 基線保護、`--stage`）；執行器自我測試 12 → 15 項；CI 依階段執行
  2. `c8f3b15`：M2-a 編輯器與 F-M2-01～03 修正；新增 EDIT-01、EDIT-02、BR-05、SEC-04 與 MUT-C6、B6、B7
  3. `af74ab3`：MUT-B7 以 BR-05 14 輪檢查
  4. `2141293`：BR-05「同步前開始」模式改用 Markdown 快捷輸入（T-M2-02）
  5. 之後的提交只新增 `app/evidence/m2/m2-a/`，不改程式

## 交付版本的結果（2141293）

- CI 完整輪數（workflow_dispatch, full=true, stage=m2-a）：https://github.com/alexliu0914/Test_NT/actions/runs/41277734258
  2026-11-01 05:38–06:39 UTC，結論 success；所有步驟 success（npm audit、型別檢查與建置、執行器自我測試、api、core、browser、變異測試）。
- CI 推送時的較少輪數：https://github.com/alexliu0914/Test_NT/actions/runs/41277734997（success）
- 本機完整輪數（本目錄）：38 個案例、1,568 輪，0 失敗；變異 29/29（M1 26 個＋M2-a 的 MUT-C6、B6、B7）；執行器自我測試 15/15。
  - `api/`：MIG-01、AUTH-01～07、SEC-01～03／05／06、PAGE-01～05（M2-c 的 VER-01／02 記為 NOT_APPLICABLE_NOT_IMPLEMENTED）
  - `core/`：M0-01～11、M0-17
  - `browser/`：BR-01～04、EDIT-01、EDIT-02、BR-05、SEC-04（M2-b／c 的案例記為 NOT_APPLICABLE_NOT_IMPLEMENTED）
  - `mutations.json`（M2-b 以後的 MUT-C1～C5、C7、C8 記為 NOT_APPLICABLE_NOT_IMPLEMENTED，不算抓到）、`runner-selftest.json`
- M1 基線：34 個 M1 案例的輪數與 26 個 M1 變異由 `test/m1-baseline.json` 機器檢查，未減少。BR-04（固定文件骨架）20/20，無回歸。
- 可試用的操作步驟：`TRIAL-STEPS.md`

## 先前版本的結果（af74ab3，保留供對照）

- `af74ab3/`：38 個案例、1,568 輪，1 輪失敗（BR-05 第 3 種模式 1/20：「甲3 的表格不存在」）；變異 29/29。同一提交的 CI 完整執行通過。
- 原因與處理見 `FAILURES.md` T-M2-02：斜線選單在第一次同步時被關閉，不是資料遺失；2141293 改用 Markdown 快捷輸入，覆蓋沒有縮小。
