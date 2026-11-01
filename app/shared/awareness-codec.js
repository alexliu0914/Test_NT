// y-protocols awareness 更新的編碼與解碼（協作伺服器用；格式與 y-protocols/awareness 的 encodeAwarenessUpdate 相同）
// 格式：varUint 筆數，每筆 varUint clientID、varUint clock、varString JSON 狀態（null 表示離開）
const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

function readVarUint(buf, pos) {
  let num = 0, mult = 1;
  for (let i = 0; i < 8; i++) {
    if (pos.i >= buf.length) throw new Error('unexpected end');
    const r = buf[pos.i++];
    num += (r & 0x7f) * mult;
    if (r < 0x80) return num;
    mult *= 128;
  }
  throw new Error('varUint too long');
}

function writeVarUint(out, num) {
  while (num > 0x7f) { out.push(0x80 | (num % 128)); num = Math.floor(num / 128); }
  out.push(num);
}

export function decodeAwareness(buf) {
  const pos = { i: 0 };
  const n = readVarUint(buf, pos);
  if (n > 64) throw new Error('too many entries');
  const entries = [];
  for (let k = 0; k < n; k++) {
    const clientId = readVarUint(buf, pos);
    const clock = readVarUint(buf, pos);
    const len = readVarUint(buf, pos);
    if (pos.i + len > buf.length) throw new Error('unexpected end');
    const json = td.decode(buf.subarray(pos.i, pos.i + len));
    pos.i += len;
    entries.push({ clientId, clock, state: JSON.parse(json) });
  }
  if (pos.i !== buf.length) throw new Error('trailing bytes');
  return entries;
}

export function encodeAwareness(entries) {
  const out = [];
  writeVarUint(out, entries.length);
  for (const e of entries) {
    writeVarUint(out, e.clientId);
    writeVarUint(out, e.clock);
    const b = te.encode(JSON.stringify(e.state ?? null));
    writeVarUint(out, b.length);
    for (const x of b) out.push(x);
  }
  return Uint8Array.from(out);
}
