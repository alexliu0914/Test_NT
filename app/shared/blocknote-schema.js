// 瀏覽器與伺服器共用的 BlockNote 結構：預設區塊＋自訂音訊區塊（只存 fileId 與倍速，不存網址）＋頁面連結區塊（M2 W1）
// 圖片、影片、音訊、檔案區塊在 M3（附件）之前不提供：保留同樣的區塊類型與屬性，讓既有內容不會被刪除，
// 但改為顯示中性的「尚未支援」提示，不使用區塊裡的網址（預設的檔案區塊會把網址放進連結，另一端可寫入危險網址；M2 W6）。
import { BlockNoteSchema, defaultBlockSpecs, createBlockSpec } from '@blocknote/core';
import { pageRegistry } from './page-registry.js';
import { PAGE_ID_RE } from './link-policy.js';

export const FRAGMENT = 'document-store';
export const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

// urlFor(fileId)：播放時才取得網址（正式版為 R2 短效網址；原型為伺服器測試音檔；手機測試頁為內嵌音檔）
export function makeAudioSpec(urlFor) {
  return createBlockSpec(
    { type: 'appAudio', propSchema: { fileId: { default: '' }, speed: { default: 1 } }, content: 'none' },
    {
      render: block => {
        const wrap = document.createElement('div');
        wrap.className = 'app-audio';
        wrap.contentEditable = 'false';
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.dataset.fileId = block.props.fileId;
        if (block.props.fileId) audio.src = urlFor(block.props.fileId);
        const speed = Number(block.props.speed) || 1;
        audio.playbackRate = speed;
        // 部分瀏覽器載入新音源時會把 playbackRate 重設為 1
        audio.addEventListener('loadedmetadata', () => { audio.playbackRate = speed; });
        const sel = document.createElement('select');
        sel.className = 'app-audio-speed';
        sel.setAttribute('aria-label', '播放速度');
        for (const s of SPEEDS) {
          const o = document.createElement('option');
          o.value = String(s);
          o.textContent = s + '×';
          if (s === speed) o.selected = true;
          sel.appendChild(o);
        }
        // 倍速是聽的人自己的設定：只改這台裝置的播放速度，不寫回文件
        // （寫回區塊屬性會重新繪製區塊、中斷正在播放的音檔）。區塊的 speed 屬性只當作預設值。
        sel.addEventListener('change', () => { audio.playbackRate = Number(sel.value); });
        wrap.append(audio, sel);
        return { dom: wrap };
      },
    },
  );
}

// 尚未支援的區塊：類型與屬性與 BlockNote 預設相同（內容完整保留），顯示時只有提示文字
const UNSUPPORTED_LABEL = { image: '圖片', video: '影片', audio: '音訊', file: '檔案' };
function unsupportedSpec(type) {
  return createBlockSpec(
    { type, propSchema: defaultBlockSpecs[type].config.propSchema, content: 'none' },
    {
      render: () => {
        const div = document.createElement('div');
        div.className = 'app-unsupported';
        div.contentEditable = 'false';
        div.dataset.unsupported = type;
        div.textContent = `這個${UNSUPPORTED_LABEL[type]}區塊目前尚未支援（附件功能在 M3），內容已保留。`;
        return { dom: div };
      },
    },
  )();
}

// 頁面連結區塊：只存 pageId。顯示時從頁面樹取目前的標題；不在頁面樹中（垃圾桶、已刪除、不存在、M2-s 起：沒有權限）一律顯示中性提示，不顯示標題
export const PAGE_LINK_UNAVAILABLE = '無法開啟的頁面（可能已刪除，或你沒有權限）';
export const pageLink = createBlockSpec(
  { type: 'pageLink', propSchema: { pageId: { default: '' } }, content: 'none' },
  {
    render: block => {
      const a = document.createElement('a');
      a.className = 'app-page-link';
      a.contentEditable = 'false';
      const id = String(block.props.pageId || '').toLowerCase();
      const paint = () => {
        const info = PAGE_ID_RE.test(id) ? pageRegistry.get(id) : null;
        if (info) {
          a.href = '/p/' + id;
          a.dataset.pageId = id;
          delete a.dataset.unavailable;
          a.textContent = (info.icon || '📄') + ' ' + (info.title || '未命名');
        } else {
          a.removeAttribute('href');
          a.dataset.unavailable = '1';
          a.textContent = '🔒 ' + PAGE_LINK_UNAVAILABLE;
        }
      };
      paint();
      const off = pageRegistry.subscribe(paint);
      a.addEventListener('click', e => {
        if (!a.dataset.pageId) { e.preventDefault(); return; }
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        pageRegistry.navigate('/p/' + a.dataset.pageId);
      });
      return { dom: a, destroy: off };
    },
  },
);

export const appAudio = makeAudioSpec(id => '/api/files/' + encodeURIComponent(id));
const blockSpecs = urlFor => ({
  ...defaultBlockSpecs,
  image: unsupportedSpec('image'), video: unsupportedSpec('video'), audio: unsupportedSpec('audio'), file: unsupportedSpec('file'),
  appAudio: makeAudioSpec(urlFor)(),
  pageLink: pageLink(),
});
export const makeSchema = urlFor => BlockNoteSchema.create({ blockSpecs: blockSpecs(urlFor) });
export const schema = BlockNoteSchema.create({ blockSpecs: blockSpecs(id => '/api/files/' + encodeURIComponent(id)) });

// FR-04 允許插入的區塊（斜線選單）；其他區塊類型保留在結構中以免刪除既有內容，但不提供插入
export const SLASH_ITEMS = ['heading', 'heading_2', 'heading_3', 'paragraph', 'bullet_list', 'numbered_list', 'check_list', 'quote', 'divider', 'code_block', 'table'];
