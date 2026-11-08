// 版本保留（M2-c 附錄 B2）：所有版本（自動、手動、還原前）依建立時間保留 90 天。
// - 每批最多 500 筆，以 FOR UPDATE SKIP LOCKED 選取：正在被還原交易鎖住（FOR SHARE）的目標版本這一輪跳過，下一輪再刪
// - 還原紀錄的引用由外鍵 on delete set null 設為空值，紀錄本身保留（restore_id 冪等不受影響）
// - 實際刪到資料時，同一交易在 version_purges 記一筆（B2-ROLLBACK：有紀錄時遷移 0003 不能無損回滾）
// 協作伺服器定時呼叫；scripts/purge-versions.mjs 可手動執行。
export const RETENTION_DAYS = 90;

export async function purgeVersions(pool, days = RETENTION_DAYS, { batch = 500 } = {}) {
  let total = 0;
  for (;;) {
    const c = await pool.connect();
    if (!c.__retentionErrorHandled) { c.on('error', () => {}); c.__retentionErrorHandled = true; }   // 連線中途被終止時不讓行程當掉（交易失敗由下方處理）
    let n = 0;
    let failed = false;
    try {
      await c.query('begin');
      const r = await c.query(
        `with del as (
           delete from page_versions where id in (
             select id from page_versions where created_at < now() - make_interval(days => $1)
              order by created_at, id for update skip locked limit $2)
           returning id)
         select count(*)::int as n from del`, [days, batch]);
      n = r.rows[0].n;
      if (n > 0) await c.query('insert into version_purges(deleted) values ($1)', [n]);
      await c.query('commit');
    } catch (e) {
      failed = true;
      try { await c.query('rollback'); } catch { /* 連線可能已中斷 */ }
      throw e;
    } finally { c.release(failed); }
    total += n;
    if (n < batch) return { purged: total };
  }
}
