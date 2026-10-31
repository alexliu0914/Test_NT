export const COLLAB_TOKEN_TTL_MS: number;
export function signCollabToken(c: { sid: string; uid: string; pid: string; name?: string; ttlMs?: number; now?: number }, key?: string): string;
export function verifyCollabToken(token: unknown, pid: string, o?: { now?: number; key?: string }): { ok: true; claims: { sid: string; uid: string; pid: string; name?: string; exp: number } } | { ok: false; reason: string };
