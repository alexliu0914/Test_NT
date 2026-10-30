// 瀏覽器與伺服器共用的 BlockNote 結構：預設區塊＋自訂音訊區塊（只存 fileId 與倍速，不存網址）
import { BlockNoteSchema, defaultBlockSpecs, createBlockSpec } from '@blocknote/core';

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

export const appAudio = makeAudioSpec(id => '/api/files/' + encodeURIComponent(id));
export const makeSchema = urlFor => BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, appAudio: makeAudioSpec(urlFor)() } });
export const schema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, appAudio: appAudio() } });
