export class IdbStore {
  constructor(key: string);
  key: string; writes: number; delayMs?: number;
  load(): Promise<any>; save(snapshot: any): Promise<void>; clear(): Promise<void>;
  static otherUserDrafts(userId: string): Promise<{ key: string; value: Record<string, unknown> }[]>;
  static unsyncedFor(userId: string): Promise<{ key: string; value: Record<string, unknown> }[]>;
  static clearUser(userId: string): Promise<void>;
  static deleteKeys(keys: string[]): Promise<void>;
}
