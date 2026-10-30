// M0-16 最小可行性：列出原型與 BlockNote 驗證用到的所有套件授權，標出 GPL／AGPL／商業或未知授權
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function collect(root, out) {
  const nm = join(root, 'node_modules');
  if (!existsSync(nm)) return;
  for (const d of readdirSync(nm)) {
    if (d.startsWith('.')) continue;
    const dirs = d.startsWith('@') ? readdirSync(join(nm, d)).map(x => join(d, x)) : [d];
    for (const name of dirs) {
      const pj = join(nm, name, 'package.json');
      if (!existsSync(pj)) continue;
      const p = JSON.parse(readFileSync(pj, 'utf8'));
      const lic = typeof p.license === 'string' ? p.license : (p.license && p.license.type) || (p.licenses && p.licenses.map(l => l.type).join(' OR ')) || 'UNKNOWN';
      out.set(`${p.name}@${p.version}`, lic);
      collect(join(nm, name), out);
    }
  }
}

const all = new Map();
collect(ROOT, all);
collect(join(ROOT, 'feasibility'), all);
const flagged = [...all].filter(([, l]) => /GPL|AGPL|SSPL|BUSL|Commercial|UNKNOWN|UNLICENSED/i.test(l) && !/LGPL/i.test(l));
const counts = {};
for (const [, l] of all) counts[l] = (counts[l] || 0) + 1;
const bn = [...all].filter(([n]) => n.startsWith('@blocknote/'));
const result = { id: 'M0-16', title: '套件授權檢查', packages: all.size, licenseCounts: counts, flagged, blocknote: bn, pass: flagged.length === 0 };
mkdirSync(join(ROOT, 'results-feas'), { recursive: true });
writeFileSync(join(ROOT, 'results-feas', 'M0-16.json'), JSON.stringify(result, null, 1));
console.log(`packages=${all.size} flagged=${flagged.length}`, flagged.slice(0, 10), bn);
console.log(counts);
process.exitCode = result.pass ? 0 : 1;
