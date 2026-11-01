// shared/client.js 的型別宣告（原始碼為 Node 測試與瀏覽器共用的 JavaScript）
import type * as Y from 'yjs';
type Listener = (...args: any[]) => void;
export interface ClientOptions {
  url: string; docId: string; token?: string; userId: string; name?: string; storage?: Record<string, any>;
  failAfterMs?: number; autoReconnect?: boolean; rnd?: () => number; trackReceived?: boolean; clearUndoOnRestore?: boolean;
  WebSocketImpl?: any; persist?: { load(): Promise<any>; save(s: any): Promise<void>; clear(): Promise<void> } | null;
  describe?: (ydoc: Y.Doc) => string; getToken?: (() => Promise<string>) | null;
}
export class Client {
  constructor(opts: ClientOptions);
  url: string; docId: string; token: string; userId: string; ydoc: Y.Doc; storage: Record<string, any>;
  repair?: (ydoc: Y.Doc) => number;
  applyRemote(data: Uint8Array): void;
  enqueueLocal(u: Uint8Array): void;
  ready: boolean; revoked: boolean; blocked: string | null; pageClosed: boolean; version: number; persistedVersion: number;
  extraUndoManagers: Set<any>; awaitingOfflineCopy: string | null | undefined;
  on(ev: string, fn: Listener): void; off(ev: string, fn: Listener): void; once(ev: string, fn: Listener): void; emit(ev: string, ...a: any[]): void;
  connect(): void; disconnect(): void; saveStatus(): 'saved' | 'saving' | 'failed' | 'unsaved'; isReadOnly(): boolean; localPersisted(): boolean;
  registerUndoManager(um: any): void; restore(versionId: string, restoreId?: string): string; makeVersion(versionId: string): Promise<any>;
  logout(o?: { waitMs?: number }): Promise<{ status: string }>; discardAndLogout(o?: { confirm?: boolean }): Promise<{ status: string }>;
  downloadUnsynced(): any; hasUnsynced(): boolean;
  // M2-s：失去權限（4005）
  accessDenied: boolean;
  deniedDraft(): { userId: string; docId: string; text: string; updates: { id: string; covers?: string[]; data: string; at: number }[] };
  saveDeniedAsCopy(): string | null; discardDenied(): void;
}
