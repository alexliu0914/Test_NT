// 每個案例的測試環境：清空測試資料庫、啟動協作伺服器與 Next.js（正式模式）、建立已完成兩步驟驗證的使用者
// 瀏覽器測試的 CSP 只允許建置時設定的協作網址，因此固定使用 27600（網頁）／27601（協作）
import { resetDb, AppProc, CollabProc, setupUsers, stopAll } from './harness.mjs';

export const WEB_PORT = 27600;
export const COLLAB_PORT = 27601;

export async function bootEnv({ users = 2, webEnv = {}, collabEnv = {} } = {}) {
  await stopAll();
  await resetDb();
  const collab = new CollabProc(COLLAB_PORT, collabEnv);
  const web = new AppProc(WEB_PORT, COLLAB_PORT, webEnv);
  await collab.start();
  await web.start();
  const us = users ? await setupUsers(web.base, users) : [];
  return { web, collab, base: web.base, users: us };
}
