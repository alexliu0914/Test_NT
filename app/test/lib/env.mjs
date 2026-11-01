// 每個案例的測試環境：清空測試資料庫、啟動協作伺服器與 Next.js（正式模式）、建立已完成兩步驟驗證的使用者
// 瀏覽器測試的 CSP 只允許建置時設定的協作網址，因此固定使用 27600（網頁）／27601（協作）
import { resetDb, AppProc, CollabProc, setupUsers, stopAll, createSharedSpace, defaults } from './harness.mjs';

// TEST_WEB_PORT／TEST_COLLAB_PORT：只用於不開瀏覽器的案例（例如同一台機器上並行開發時）；瀏覽器案例必須用預設值
export const WEB_PORT = Number(process.env.TEST_WEB_PORT || 27600);
export const COLLAB_PORT = Number(process.env.TEST_COLLAB_PORT || 27601);

// M2-s：shared（預設 true）＝建立一個所有測試帳號都是成員的共享空間，M1 案例的頁面建在這裡（只改前提，判定不變；FAILURES.md T-M2-03）
export async function bootEnv({ users = 2, webEnv = {}, collabEnv = {}, shared = true } = {}) {
  await stopAll();
  await resetDb();
  const collab = new CollabProc(COLLAB_PORT, collabEnv);
  const web = new AppProc(WEB_PORT, COLLAB_PORT, webEnv);
  await collab.start();
  await web.start();
  const us = users ? await setupUsers(web.base, users) : [];
  defaults.spaceId = shared && us.length ? await createSharedSpace(us[0], us.slice(1)) : null;
  return { web, collab, base: web.base, users: us, shared: defaults.spaceId };
}
