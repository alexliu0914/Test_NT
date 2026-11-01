// 測試分段啟用清單（M2 計畫 v0.4 §5、附錄 B-4）
// - manifest.json：每個案例的階段、群組、完整輪數、CI 縮減輪數；每個變異的階段
// - m1-baseline.json：M1 封存基線（5f7bd04）的案例完整輪數與變異；M2 不能刪除、改階段或減少完整輪數
// - accepted-baselines.json：已驗收的 M2 階段（M2-a 2141293、M2-s d78a094）新增的案例與變異，規則同上
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TEST_DIR = fileURLToPath(new URL('..', import.meta.url));
export const MANIFEST_PATH = TEST_DIR + 'manifest.json';
export const BASELINE_PATH = TEST_DIR + 'm1-baseline.json';
export const ACCEPTED_PATH = TEST_DIR + 'accepted-baselines.json';
export const NOT_APPLICABLE = 'NOT_APPLICABLE_NOT_IMPLEMENTED';

export function loadManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// 回傳問題清單（空陣列＝通過）
export function checkManifest(man, baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')), accepted = JSON.parse(readFileSync(ACCEPTED_PATH, 'utf8'))) {
  const errs = [];
  const stages = man.stages || [];
  if (!stages.length || stages[0] !== 'm1') errs.push('stages 必須以 m1 開頭');
  if (!stages.includes(man.final)) errs.push('final 階段不在 stages 中');
  const seen = new Set();
  for (const c of man.cases || []) {
    if (seen.has(c.id)) errs.push(`案例重複：${c.id}`);
    seen.add(c.id);
    if (!stages.includes(c.stage)) errs.push(`${c.id} 的階段 ${c.stage} 不存在`);
    if (!(man.groups || []).includes(c.group)) errs.push(`${c.id} 的群組 ${c.group} 不存在`);
    if (!Number.isInteger(c.full) || c.full <= 0 || !Number.isInteger(c.quick) || c.quick <= 0) errs.push(`${c.id} 的輪數無效`);
  }
  const byId = Object.fromEntries((man.cases || []).map(c => [c.id, c]));
  for (const [id, full] of Object.entries(baseline.cases)) {
    const c = byId[id];
    if (!c) errs.push(`M1 基線案例被移除：${id}`);
    else {
      if (c.stage !== 'm1') errs.push(`M1 基線案例被改到其他階段：${id}（${c.stage}）`);
      if (c.full < full) errs.push(`M1 基線案例的完整輪數被減少：${id}（${full} → ${c.full}）`);
    }
  }
  const mut = Object.fromEntries((man.mutants || []).map(m => [m.id, m]));
  for (const m of man.mutants || []) if (!stages.includes(m.stage)) errs.push(`變異 ${m.id} 的階段 ${m.stage} 不存在`);
  for (const id of baseline.mutants) {
    if (!mut[id]) errs.push(`M1 基線變異被移除：${id}`);
    else if (mut[id].stage !== 'm1') errs.push(`M1 基線變異被改到其他階段：${id}`);
  }
  // 已驗收的 M2 階段：案例與變異不能移除、改階段或減少完整輪數（後段開發不得弱化已驗收的檢查）
  for (const [stage, b] of Object.entries(accepted.stages || {})) {
    for (const [id, full] of Object.entries(b.cases)) {
      const c = byId[id];
      if (!c) errs.push(`已驗收階段 ${stage} 的案例被移除：${id}`);
      else {
        if (c.stage !== stage) errs.push(`已驗收階段 ${stage} 的案例被改到其他階段：${id}（${c.stage}）`);
        if (c.full < full) errs.push(`已驗收階段 ${stage} 的案例完整輪數被減少：${id}（${full} → ${c.full}）`);
      }
    }
    for (const id of b.mutants) {
      if (!mut[id]) errs.push(`已驗收階段 ${stage} 的變異被移除：${id}`);
      else if (mut[id].stage !== stage) errs.push(`已驗收階段 ${stage} 的變異被改到其他階段：${id}`);
    }
  }
  return errs;
}

export const stageIndex = (man, s) => man.stages.indexOf(s);
export const isActive = (man, item, stage) => stageIndex(man, item.stage) <= stageIndex(man, stage);
