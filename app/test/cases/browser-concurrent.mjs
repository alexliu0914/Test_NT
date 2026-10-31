// BR-04：兩人同時開始編輯新頁面（F-M1-05 的回歸測試）
// 新頁面的協作文件原本是空的，第一次輸入時才建立骨架；兩人同時開始輸入時各自建立一份，合併後編輯器只能顯示一份，
// 其中一方的內容消失（狀態仍顯示已儲存）。M0-B 的 BR-01 讓兩人在不同的既有段落輸入（T-03），所以沒有測到。
// 每輪一個新頁面，四種開始方式輪流：
//   0 已同步後：B 在第一段輸入，同時 A 在後面按 Enter 開新段落輸入（重現 F-M1-05 的情境）
//   1 已同步後：兩人同時在同一個空段落輸入（字元可能交錯，但兩人輸入的每個字都要在）
//   2 尚未同步：編輯器一出現就輸入（不等協作連線）
//   3 已同步後：A 連按 Enter 開多個段落並輸入，同時 B 在第一段輸入
// 檢查：兩邊與資料庫的區塊完全一致、兩人輸入的字都在、文件只有一個頂層骨架、沒有頁面錯誤
import { isDeepStrictEqual } from 'node:util';
import { newPage, sleep } from '../lib/harness.mjs';
import { loadFromDb } from '../lib/m0-compat.mjs';
import { Recorder, within } from '../lib/recorder.mjs';
import { bootEnv } from '../lib/env.mjs';
import { blocksOfState } from '../../shared/export.js';
import { loadPlaywright, launch, newProfileDir, rmProfile, useAgentCookies, openDoc, waitSynced, blocks } from '../lib/browser.mjs';

const A_CHARS = '甲乙丙丁戊己庚辛', B_CHARS = '天地玄黃宇宙洪荒';
const canon = x => JSON.parse(JSON.stringify(x));
const textOf = bs => JSON.stringify(bs.map(b => (Array.isArray(b.content) ? b.content.map(c => c.text || '').join('') : '')));
const countIn = (s, ch) => s.split(ch).length - 1;
const topLevel = P => P.evaluate(() => window.__app.client.ydoc.getXmlFragment('document-store').length);

async function typeIn(P, s, { enters = 0, where = 'end' } = {}) {
  await P.locator('.bn-editor').focus();
  await P.keyboard.press(where === 'start' ? 'Control+Home' : 'Control+End');
  for (let i = 0; i < enters; i++) await P.keyboard.press('Enter');
  await P.keyboard.type(s, { delay: 15 });
}

export async function br04(N) {
  const rec = new Recorder('BR-04', '兩人同時開始編輯新頁面：兩邊與資料庫一致、兩人輸入的字都在、只有一個文件骨架（F-M1-05）');
  const env = await bootEnv({ users: 2 });
  const [UA, UB] = env.users;
  const pw = await loadPlaywright();
  const dA = newProfileDir(), dB = newProfileDir();
  const cA = await launch(pw, dA), cB = await launch(pw, dB);
  await useAgentCookies(cA, UA.agent); await useAgentCookies(cB, UB.agent);
  const A = cA.pages()[0] || await cA.newPage();
  const B = cB.pages()[0] || await cB.newPage();
  const lat = [];
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = { mode: r % 4 };
      try {
        await within((async () => {
          const docId = await newPage(UA.agent, `同時開始${r}`);
          const mode = r % 4;
          if (mode === 2) {
            // 不等協作連線：編輯器一出現就輸入
            await Promise.all([A, B].map(P => P.goto(`${env.base}/p/${docId}`)));
            await Promise.all([A, B].map(P => P.locator('.bn-editor[contenteditable="true"]').waitFor({ timeout: 20000 })));
          } else {
            await Promise.all([openDoc(A, env.base, docId), openDoc(B, env.base, docId)]);
            await Promise.all([waitSynced(A), waitSynced(B)]);
          }
          if (mode === 0 || mode === 2) await Promise.all([typeIn(B, B_CHARS), typeIn(A, A_CHARS, { enters: 1 })]);
          else if (mode === 1) await Promise.all([typeIn(B, B_CHARS), typeIn(A, A_CHARS)]);
          else await Promise.all([typeIn(B, B_CHARS, { where: 'start' }), typeIn(A, A_CHARS, { enters: 3 })]);
          const t0 = Date.now();
          // 等兩邊與資料庫一致（最多 10 秒）
          let ba, bb, bd;
          for (;;) {
            await Promise.all([waitSynced(A, 15000).catch(() => {}), waitSynced(B, 15000).catch(() => {})]);
            [ba, bb, bd] = [canon(await blocks(A)), canon(await blocks(B)), canon(blocksOfState((await loadFromDb(docId)).update))];
            if (isDeepStrictEqual(ba, bb) && isDeepStrictEqual(ba, bd)) break;
            if (Date.now() - t0 > 10000) {
              fails.push('10 秒內沒有一致 A=' + textOf(ba) + ' B=' + textOf(bb) + ' DB=' + textOf(bd));
              break;
            }
            await sleep(200);
          }
          lat.push(Date.now() - t0);
          const all = textOf(ba).replace(/[[\]",]/g, '');
          const lostA = [...A_CHARS].filter(ch => countIn(all, ch) < 1), lostB = [...B_CHARS].filter(ch => countIn(all, ch) < 1);
          if (lostA.length) fails.push('A 輸入的字消失：' + lostA.join(''));
          if (lostB.length) fails.push('B 輸入的字消失：' + lostB.join(''));
          for (const [n, P] of [['A', A], ['B', B]]) {
            const t = await topLevel(P);
            if (t !== 1) fails.push(`${n} 的文件有 ${t} 個頂層骨架`);
          }
          m.text = textOf(ba);
        })(), 90000, 'round');
      } catch (e) { fails.push('exception: ' + e.message); }
      for (const [n, P] of [['A', A], ['B', B]]) if (P.__errors && P.__errors.length) { fails.push(n + ' page error: ' + P.__errors.join(' / ').slice(0, 300)); P.__errors = []; }
      rec.add(r, r, fails, m);
    }
  } finally {
    await cA.close().catch(() => {}); await cB.close().catch(() => {});
    rmProfile(dA); rmProfile(dB);
  }
  lat.sort((a, b) => a - b);
  return rec.save({ converge: { p50: lat[Math.floor(lat.length / 2)], max: lat.at(-1) } });
}
