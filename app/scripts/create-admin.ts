// 部署時建立第一個管理者帳號與工作區（計畫書 7.1）。之後的帳號只能透過邀請連結建立。
// 用法：npx tsx scripts/create-admin.ts --email you@example.com --name 名字   （密碼從標準輸入讀取，不留在指令歷史）
import { createInterface } from 'node:readline';
import { pool } from '../src/lib/db';
import { createUserWithPassword } from '../src/lib/accounts';

function arg(name: string) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; }

async function readPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;   // 自動化部署／測試用
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise(res => rl.question('密碼（至少 12 個字元）：', a => { rl.close(); res(a); }));
}

const email = arg('email');
const name = arg('name') || '';
const workspace = arg('workspace') || '我的工作區';
if (!email) { console.error('用法：npx tsx scripts/create-admin.ts --email you@example.com --name 名字'); process.exit(1); }
try {
  const existing = await pool.query(`select count(*)::int as n from "user" where role = 'admin'`);
  if (existing.rows[0].n > 0 && !process.argv.includes('--force')) throw new Error('已經有管理者帳號；之後的帳號請用邀請連結建立');
  await pool.query('insert into workspaces(name) select $1 where not exists (select 1 from workspaces)', [workspace]);
  const user = await createUserWithPassword(email, name, await readPassword(), 'admin');
  console.log(`已建立管理者 ${user.email}。第一次登入時必須設定兩步驟驗證。`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally { await pool.end(); }
