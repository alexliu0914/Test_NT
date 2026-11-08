export function draftKey(userId: string, pageId: string): string;
export function pageIdOfKey(key: string): string;
export function isUnsynced(v: unknown): boolean;
export type IdbStatus = { blocked: boolean; versionChanged: boolean; listeners: Set<(s: IdbStatus) => void> };
export const idbStatus: IdbStatus;
export class IdbStore {
  constructor(key: string);
  key: string; writes: number; delayMs?: number;
  static forPage(userId: string, pageId: string): IdbStore;
  load(): Promise<any>; save(snapshot: any): Promise<void>; clear(): Promise<void>;
  static unsyncedFor(userId: string): Promise<{ key: string; value: Record<string, unknown> }[]>;
  static draftsFor(userId: string): Promise<{ key: string; value: Record<string, unknown> }[]>;
  static clearUser(userId: string): Promise<void>;
  static deleteOwn(userId: string, keys: string[]): Promise<number>;
  static orphanCount(): Promise<number>;
  static clearOrphans(): Promise<void>;
}
