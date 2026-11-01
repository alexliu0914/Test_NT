export function tolerateMultiContent(pmSchema: any): void;
export function findMultiContent(fragment: any): { container: any; extras: any[] }[];
export function cloneNode(node: any): any;
export function repairByAuthor(ydoc: any, fragment: any, isMine: (clientId: number) => boolean, newId: () => string, origin?: string): number;
export function ownClientIds(ydoc: any, pendingUpdates: Uint8Array[]): Set<number>;
