// 五種儲存狀態（M2 計畫 v0.5 W3、FR-10）：由用戶端的實際狀態推導，顯示不得誇大已完成的步驟
//
// | 狀態    | 畫面用詞                 | 條件（依下列優先順序判定，第一個成立的為準）                                   |
// | unsaved | 尚未存到此裝置           | 有本機修改尚未完成 IndexedDB 耐久寫入（此時關閉頁面可能遺失）                    |
// | saved   | 已儲存                   | 沒有待確認更新、未確認的衝突副本或離線副本（每一筆都收到對應 update_id 的已提交確認） |
// | offline | 離線，內容保存在此裝置   | 有尚未確認的修改（已寫入本機）、目前沒有連上協作伺服器                           |
// | failed  | 儲存失敗                 | 已連線，但伺服器回報資料庫寫入失敗，或最舊的待確認修改超過 failAfterMs 仍未確認    |
// | saving  | 儲存中                   | 已連線、已寫入本機，等待伺服器提交確認，且沒有已知的失敗                          |
//
// 交疊情境：
// - 資料庫失敗＋本機尚未寫入完成 → unsaved（最可能遺失的狀態優先）
// - 資料庫失敗＋離線 → offline（離線時無法得知伺服器狀態；伺服器的失敗旗標在斷線時清除，重新連線後由伺服器再次告知）
// - 資料庫失敗期間收到其他 update_id 的確認 → 仍為 failed：確認只移除相符的 id，failed 由伺服器的恢復通知或待確認清單清空才解除
export function deriveSaveState(s) {
  if (s.unpersisted) return 'unsaved';
  if (!s.unsynced) return 'saved';
  if (!s.connected) return 'offline';
  if (s.dbFailing) return 'failed';
  if (s.oldestPendingAgeMs > s.failAfterMs) return 'failed';
  return 'saving';
}

export const SAVE_STATES = ['unsaved', 'saved', 'offline', 'failed', 'saving'];
