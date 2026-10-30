// 附件引用模型（計畫書第 6 節）：blobs = 實體檔案（以 SHA-256 唯一），files = 頁面對實體檔案的引用。
// 物件儲存以本機目錄代替 R2；時間以參數傳入，方便測試快轉。
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DAY = 86400000;
export const PAGE_PURGE_DAYS = 30;
export const BLOB_GRACE_DAYS = 7;

export const SCHEMA = `
drop table if exists att_files, att_blobs, att_pages cascade;
create table att_pages (id text primary key, deleted_at timestamptz);
create table att_blobs (
  id text primary key, sha256 text not null unique, storage_key text not null,
  size_bytes bigint not null, status text not null, orphaned_at timestamptz, created_at timestamptz not null);
create table att_files (
  id text primary key, page_id text not null references att_pages(id), blob_id text not null references att_blobs(id),
  created_at timestamptz not null, deleted_at timestamptz);
`;

export class Attachments {
  constructor(pool, dir) { this.pool = pool; this.dir = dir; mkdirSync(dir, { recursive: true }); }

  // 上傳：相同 SHA-256 的 blob 已 ready 時只建立引用；否則建立 blob（並發時以唯一鍵保證只有一份）
  async upload(pageId, sha, bytes, now) {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query('insert into att_pages(id) values ($1) on conflict do nothing', [pageId]);
      const ins = await c.query(`insert into att_blobs(id, sha256, storage_key, size_bytes, status, created_at)
        values ($1,$2,$3,$4,'uploading',$5) on conflict (sha256) do nothing returning id`,
        [randomUUID(), sha, 'blob/' + sha, bytes.length, new Date(now)]);
      const blob = (await c.query('select id, status from att_blobs where sha256=$1 for update', [sha])).rows[0];
      // 新引用出現：取消待刪除
      await c.query('update att_blobs set orphaned_at = null where id=$1', [blob.id]);
      const fileId = randomUUID();
      await c.query('insert into att_files(id, page_id, blob_id, created_at) values ($1,$2,$3,$4)', [fileId, pageId, blob.id, new Date(now)]);
      await c.query('commit');
      const needUpload = ins.rowCount === 1;
      if (needUpload) {
        writeFileSync(this.dir + '/' + sha, bytes);
        await this.pool.query(`update att_blobs set status='ready' where id=$1`, [blob.id]);
      }
      return { fileId, blobId: blob.id, reused: !needUpload };
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  }

  async deletePage(pageId, now) {
    await this.pool.query('update att_pages set deleted_at=$2 where id=$1', [pageId, new Date(now)]);
    await this.pool.query('update att_files set deleted_at=$2 where page_id=$1 and deleted_at is null', [pageId, new Date(now)]);
  }

  async restorePage(pageId) {
    await this.pool.query('update att_pages set deleted_at=null where id=$1', [pageId]);
    await this.pool.query('update att_files set deleted_at=null where page_id=$1', [pageId]);
  }

  // 清理工作：頁面刪除滿 30 天才刪引用；blob 沒有任何引用時記錄 orphaned_at，滿 7 天才刪實體檔案
  async purge(now) {
    const c = await this.pool.connect();
    const removed = [];
    try {
      await c.query('begin');
      await c.query(`delete from att_files f using att_pages p where f.page_id=p.id and p.deleted_at is not null
        and p.deleted_at < $1`, [new Date(now - PAGE_PURGE_DAYS * DAY)]);
      await c.query(`update att_blobs b set orphaned_at=$1 where orphaned_at is null
        and not exists (select 1 from att_files f where f.blob_id=b.id)`, [new Date(now)]);
      const gone = (await c.query(`delete from att_blobs b where orphaned_at is not null and orphaned_at < $1
        and not exists (select 1 from att_files f where f.blob_id=b.id) returning sha256`, [new Date(now - BLOB_GRACE_DAYS * DAY)])).rows;
      await c.query('commit');
      for (const g of gone) { const p = this.dir + '/' + g.sha256; if (existsSync(p)) unlinkSync(p); removed.push(g.sha256); }
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    return removed;
  }

  async playable(fileId) {
    const r = (await this.pool.query(`select b.sha256, b.status, f.deleted_at from att_files f join att_blobs b on b.id=f.blob_id
      where f.id=$1`, [fileId])).rows[0];
    return !!r && r.status === 'ready' && !r.deleted_at && existsSync(this.dir + '/' + r.sha256);
  }
}
