# M2-c 驗證證據（版本與草稿）

## 交付版本

- **受測提交：96ade848fbd40d35b2c74a8aab2ed660952bb425**（分支 `m2c`）。本目錄的結果都是這個提交，各 `summary.json` 的 `tested_sha` 相同，`dirty: false`。
- 基線：M2-b 已驗收提交 `27a0ca2`（`test/accepted-baselines.json`）。M1、M2-a、M2-s、M2-b 的已驗收案例與變異沒有移除、改階段或減少輪數（執行器與變異清單檢查）。
- 設計依據：M2-c 附錄 B（B1～B3）兩輪審核，見 Docs「M2-c 附錄 B 設計方案（B1～B3）」。
- 提交關係（由舊到新，都在 `m2c` 分支，從 main `7e27e1c` 開出）：
  1. `b3ecf0f`、`d6f9c47`：F-M2-12 開發模式復原（M2-c 第一項維護任務）；DEV-01、MUT-F12
  2. `daf0557`：遷移 0003 與安全回滾
  3. `d5121ee`：排程自動存版與 90 天清理；VER-01、MUT-C4、V1、V2
  4. `c190e10`：W4 版本面板、預覽與還原；VER-02、COL-05、COL-08、MUT-C5；T-M2-13、T-M2-14
  5. `413e5ce`：W5 草稿依帳號分區、舊草稿遷移、登出流程；SEC-12、MUT-C7、D1；T-M2-15
  6. `af73afe`：manifest 切到 m2-c；README
  7. `96ade84`：T-M2-16（BR-03、ACL-04）
  8. 之後的提交只新增本目錄，不改程式

## 交付版本的結果（96ade84）

### CI

- **完整輪數**（workflow_dispatch，full=true，stage=m2-c）：https://github.com/alexliu0914/Test_NT/actions/runs/42476818223
  - 2026-11-08 11:41–13:50 UTC，結論 success。
  - 執行器自我測試 21/21；api、core、browser 全部通過；變異 53/53。
- **推送時的縮減輪數**：https://github.com/alexliu0914/Test_NT/actions/runs/42476780959（success）

### 本機完整輪數（本目錄）

- 總計：**59 個案例、1,836 輪，0 失敗**；變異 53/53；執行器自我測試 21/21；`unit-conversion-rescue.log` 單元測試全部通過。
- `api/`：25 個案例、306 輪（M2-b 的 23 個案例＋VER-01 5 輪、VER-02 5 輪）。
- `core/`：12 個案例、1,230 輪。
- `browser/`：22 個案例、300 輪（M2-b 的 18 個案例＋DEV-01 5、COL-05 10、COL-08 20、SEC-12 10）。
- M2-d 的 PERF-01～03 記為 NOT_APPLICABLE_NOT_IMPLEMENTED。
- 與 M2-b 相比：+6 個案例，+55 輪（1,781 → 1,836）。

### 變異（`mutations.json`）

- 53/53＝M1 26＋M2-a 3＋M2-s 9＋M2-b 8＋M2-c 7。本機分三批執行後合併；CI 一次執行，結果相同。

| 變異 | 內容 | 攔截的測試 |
|---|---|---|
| MUT-F12 | 開發模式（StrictMode）停掉的復原管理器不重新監聽文件 | DEV-01 |
| MUT-C4 | 自動存版不看是否有新更新 | VER-01 |
| MUT-V1 | 自動存版只看這次啟動後才開始的計時（重啟後不補存） | VER-01 |
| MUT-V2 | 還原不在交易內鎖住目標版本 | VER-01 |
| MUT-C5 | 版本預覽端點繞過登入 | VER-02 |
| MUT-C7 | 有未同步修改時登出仍清掉草稿 | SEC-12 |
| MUT-D1 | 遷移時丟掉無法辨識所有者的舊草稿 | SEC-12 |
| MUT-B4（M1，改寫，T-M2-15） | 讀草稿時不分帳號 | BR-02 |

### 測試變更（都記在 `FAILURES.md`）

- T-M2-13：ACL-01 路由註冊表、SEC-05 端點清單加入三個只讀版本 API（只新增）。
- T-M2-14：MIG-02 只套用到 0002（`migrate.mjs up` 可指定最後一個遷移）。
- T-M2-15（使用者核准）：BR-02 S5、COL-10 的封鎖判定與 MUT-B4 植入內容改寫為草稿分區的判定；原始證據保留（`evidence/m1/`、`evidence/m2/m2-b/`），完整差異 `T-M2-15-tests.diff`。
- T-M2-16：BR-03 登出確認的等待上限（10 秒同步後才出現）與取消按鈕；ACL-04 的 IndexedDB 輔助函式改用新鍵，讀不到時記為失敗。
- 沒有任何判定被放寬。

### 未通過的驗證紀錄（保留，不覆蓋）

| 提交 | 結果 | 處理 |
|---|---|---|
| `b3ecf0f` | 本機 M2-b 瀏覽器縮減輪數第一次全部失敗：建置時漏設 `COLLAB_PUBLIC_URL`（CSP 擋掉協作連線），與修正無關；重新建置後 18 個案例全過 | 記錄於 F-M2-12 |
| `af73afe` | 本機與 CI（https://github.com/alexliu0914/Test_NT/actions/runs/42475381320）縮減輪數 BR-03、ACL-04 失敗 | T-M2-16 |

### 實際試用

- `TRIAL-STEPS.md`：四個帳號、正式模式。
- 結果待使用者回報。
