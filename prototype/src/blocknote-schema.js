// 瀏覽器與伺服器共用的 BlockNote 結構：預設區塊＋自訂音訊區塊（只存 fileId 與倍速，不存網址）
import { BlockNoteSchema, defaultBlockSpecs, createBlockSpec } from '@blocknote/core';

export const FRAGMENT = 'document-store';

export const appAudio = createBlockSpec(
  { type: 'appAudio', propSchema: { fileId: { default: '' }, speed: { default: 1 } }, content: 'none' },
  {
    render: block => {
      const wrap = document.createElement('div');
      wrap.className = 'app-audio';
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.dataset.fileId = block.props.fileId;
      // 播放時才以 fileId 取得網址；原型以伺服器的測試音檔代替 R2 預簽名網址
      if (block.props.fileId) audio.src = '/api/files/' + encodeURIComponent(block.props.fileId);
      audio.playbackRate = Number(block.props.speed) || 1;
      wrap.appendChild(audio);
      return { dom: wrap };
    },
  },
);

export const schema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, appAudio: appAudio() } });
