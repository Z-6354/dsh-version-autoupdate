/**
 * Same-directory atomic JSON write.
 * Windows cannot reliably `rename(tmp → existing)` (EPERM when destination is locked
 * or simply exists); unlink destination first and retry briefly for AV/indexing locks.
 */
export declare function writeJsonFileAtomic(target: string, value: unknown): Promise<void>;
//# sourceMappingURL=atomic-json-write.d.ts.map