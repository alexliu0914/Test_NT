// M0-12 最小可行性：BlockNote 區塊（含自訂音訊區塊）在 Yjs 狀態與 JSON 匯出／匯回之間往返是否無損
import { BlockNoteSchema, defaultBlockSpecs, createBlockSpec } from '@blocknote/core';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import * as Y from 'yjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const OUT = fileURLToPath(new URL('../results-feas/', import.meta.url));

const appAudio = createBlockSpec(
  { type: 'appAudio', propSchema: { fileId: { default: '' }, speed: { default: 1 } }, content: 'none' },
  {
    render: block => {
      const dom = document.createElement('audio');
      dom.setAttribute('data-file-id', block.props.fileId);
      return { dom };
    },
  },
)();
const schema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, appAudio } });
const editor = ServerBlockNoteEditor.create({ schema });

let a = 12012;
const rnd = () => { // mulberry32
  a = (a + 0x6d2b79f5) >>> 0; let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = a => a[Math.floor(rnd() * a.length)];
const words = ['今天', '完成', '專案', '規格', '交換器', '韌體', '網路設定', 'VPN', 'Docker', '會議', '音檔', '筆記', 'Yjs', '同步'];
const text = () => Array.from({ length: 2 + Math.floor(rnd() * 6) }, () => pick(words)).join(' ');
let uid = 0;
const id = () => 'b' + (uid++);
const styled = () => {
  const out = [];
  for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
    const r = rnd();
    if (r < 0.2) out.push({ type: 'link', href: 'https://example.com/' + k, content: [{ type: 'text', text: text(), styles: {} }] });
    else out.push({ type: 'text', text: text() + ' ', styles: r < 0.5 ? { bold: true } : r < 0.7 ? { italic: true, textColor: 'red' } : {} });
  }
  return out;
};

function block(depth = 0) {
  const t = pick(['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'quote', 'codeBlock', 'appAudio', 'image', 'table', 'divider', 'toggleListItem']);
  const b = { id: id(), type: t };
  switch (t) {
    case 'heading': b.props = { level: 1 + Math.floor(rnd() * 3) }; b.content = styled(); break;
    case 'checkListItem': b.props = { checked: rnd() < 0.5 }; b.content = styled(); break;
    case 'codeBlock': b.props = { language: 'javascript' }; b.content = [{ type: 'text', text: 'const x = 1;\nconsole.log(x);', styles: {} }]; break;
    case 'appAudio': b.props = { fileId: 'f-' + Math.floor(rnd() * 1e6), speed: pick([0.5, 1, 1.5, 2]) }; break;
    case 'image': b.props = { url: 'https://example.com/i.png', caption: text() }; break;
    case 'divider': break;
    case 'table': b.content = { type: 'tableContent', rows: [0, 1].map(() => ({ cells: [0, 1, 2].map(() => [{ type: 'text', text: text(), styles: {} }]) })) }; break;
    default: b.content = styled();
  }
  if ((t === 'bulletListItem' || t === 'numberedListItem' || t === 'toggleListItem') && depth < 2 && rnd() < 0.5) {
    b.children = [block(depth + 1), block(depth + 1)];
  }
  return b;
}

const N = 50;
let ok = 0; const fails = []; let mdLossy = 0; const typeCount = {};
for (let i = 0; i < N; i++) {
  const blocks0 = Array.from({ length: 8 + Math.floor(rnd() * 12) }, () => block());
  blocks0.forEach(b => { typeCount[b.type] = (typeCount[b.type] || 0) + 1; });
  const ydoc1 = editor.blocksToYDoc(blocks0, 'document-store');
  const A = editor.yDocToBlocks(ydoc1, 'document-store');
  // 匯出：Yjs 狀態 ＋ 帶格式版本號的區塊 JSON
  const state = Y.encodeStateAsUpdate(ydoc1);
  const exported = JSON.stringify({ formatVersion: 1, blocks: A });
  // 匯回路徑 1：Yjs 狀態
  const ydoc2 = new Y.Doc(); Y.applyUpdate(ydoc2, state);
  const B1 = editor.yDocToBlocks(ydoc2, 'document-store');
  // 匯回路徑 2：區塊 JSON
  const B2 = editor.yDocToBlocks(editor.blocksToYDoc(JSON.parse(exported).blocks, 'document-store'), 'document-store');
  const a = JSON.stringify(A);
  const sig = bs => JSON.stringify(bs.filter(b => b.type === 'appAudio').map(b => [b.id, b.props.fileId, b.props.speed]));
  const audioKept = sig(A) === sig(blocks0);
  if (a === JSON.stringify(B1) && a === JSON.stringify(B2) && audioKept) ok++;
  else fails.push({ i, y: a === JSON.stringify(B1), json: a === JSON.stringify(B2), audioKept });
  // 對照：Markdown 匯出是否有損
  const md = await editor.blocksToMarkdownLossy(A);
  const back = await editor.tryParseMarkdownToBlocks(md);
  if (JSON.stringify(back.map(b => b.type)) !== JSON.stringify(A.map(b => b.type))) mdLossy++;
}
const result = { id: 'M0-12', title: 'BlockNote 區塊（含自訂音訊區塊）Yjs 與 JSON 往返', total: N, passed: ok, failed: N - ok, fails: fails.slice(0, 10), markdownLossyDocs: mdLossy, blockTypes: typeCount, blocknoteVersion: '0.56.0' };
mkdirSync(OUT, { recursive: true });
writeFileSync(OUT + 'M0-12.json', JSON.stringify(result, null, 1));
console.log(JSON.stringify({ ...result, fails: result.fails.length }));
// 失敗時退出碼非 0（CI 阻擋）
process.exitCode = result.failed === 0 && result.total > 0 ? 0 : 1;
