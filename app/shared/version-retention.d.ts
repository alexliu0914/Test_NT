export const RETENTION_DAYS: number;
export function purgeVersions(pool: unknown, days?: number, opts?: { batch?: number }): Promise<{ purged: number }>;
