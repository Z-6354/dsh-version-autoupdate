/** Precise tsc -b / pnpm Progress parsing; keep CPU/IO light (stdout only). */
export declare function stripAnsi(text: string): string;
/** Split on CR and LF — pnpm Progress rewrites the same line with \\r. */
export declare function splitBuildLines(chunk: string): string[];
export declare function lastUsefulBuildLine(chunk: string): string | null;
export declare function formatBuildProgressMessage(label: string, detail: string | null): string;
/** One-shot JSONC strip for tsconfig.host.json (no full JSONC parser). */
export declare function stripJsonc(text: string): string;
export declare function countTsconfigReferences(tsconfigJsonText: string): number;
/** Map a done/total fraction onto an overall percent band (inclusive). */
export declare function mapFractionToBand(done: number, total: number, bandStart: number, bandEnd: number): number;
export interface PnpmProgressCounts {
    resolved: number;
    reused: number;
    downloaded: number;
    added: number;
}
/** Parse pnpm's `Progress: resolved N, reused N, downloaded N, added N` line. */
export declare function parsePnpmProgressLine(line: string): PnpmProgressCounts | null;
/**
 * Exact install fraction from pnpm Progress counts.
 * Linking: added/resolved. Fetch-only: (reused+downloaded)/resolved * 0.85.
 */
export declare function pnpmProgressFraction(counts: PnpmProgressCounts): number;
export declare function formatPnpmProgressDetail(counts: PnpmProgressCounts, installPercent: number): string;
/**
 * Tracks `tsc -b --verbose` project completions.
 * Counts only terminal project events (Building / up to date / Skipping) — not "out of date".
 */
export declare class TscSolutionProgress {
    done: number;
    total: number;
    private collectingList;
    private listed;
    constructor(fallbackTotal: number);
    feed(chunk: string): {
        changed: boolean;
        done: number;
        total: number;
        projectPercent: number;
        message: string;
    };
    markComplete(): {
        done: number;
        total: number;
        projectPercent: number;
        message: string;
    };
}
/** Fallback when Progress line is absent (Packages: / Done). */
export type BuildTrackKind = 'install';
export declare function bumpBuildPercent(kind: BuildTrackKind, line: string, current: number): number;
//# sourceMappingURL=build-progress.d.ts.map