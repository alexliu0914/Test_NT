// Node.js 與瀏覽器共用的小工具（不依賴 node: 模組）
export class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) { if (!this._h.has(ev)) this._h.set(ev, new Set()); this._h.get(ev).add(fn); return this; }
  off(ev, fn) { this._h.get(ev)?.delete(fn); return this; }
  once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
  emit(ev, ...a) { for (const fn of [...(this._h.get(ev) || [])]) fn(...a); return true; }
}

export const uuid = () => globalThis.crypto.randomUUID();

export function b64(u) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u).toString('base64');
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
