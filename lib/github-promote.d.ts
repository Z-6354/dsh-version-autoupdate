export type RunGit = (args: string[], cwd: string) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
/** Collect `lib` dirs under apps|packages|vendor|native (skip node_modules). */
export declare function listHarnessLibDirs(root: string): Promise<string[]>;
/** Copy built lib trees from staging onto live (after sources already match the tag). */
export declare function copyHarnessBuildArtifacts(stagingRoot: string, liveRoot: string): Promise<number>;
/**
 * Fail if any apps|packages|vendor|native package declares a lib entrypoint that is missing.
 * Prevents host-only staging from promoting a tree that cannot boot web plugins.
 * Skips test fixtures (`@fixture/*` or path under tests/fixtures).
 */
export declare function assertHarnessLibEntrypoints(root: string): Promise<void>;
/**
 * After relink, live must expose every `@deepseek-ai/*` link that staging's web-app has.
 * Skips when staging has no web-app node_modules (unit fixtures).
 */
export declare function assertLiveWorkspaceLinked(liveRoot: string, stagingRoot: string): Promise<void>;
export interface PromoteResult {
    previousRef: string;
    tag: string;
    libsCopied: number;
    /** How many lib/dist trees were snapshotted from live before checkout (0 if none / no backup root). */
    artifactsSnapshotted: number;
    rolledBack: false;
    message: string;
}
export interface RollbackLiveResult {
    previousRef: string;
    artifactsRestored: number;
}
/**
 * Restore live to a prior git ref and re-apply snapshotted lib/dist (gitignored).
 * Does NOT relink — caller must relink when node_modules may still match the failed promote.
 */
export declare function rollbackLiveToPreviousRef(input: {
    liveRoot: string;
    previousRef: string;
    artifactBackupRoot?: string;
    runGit: RunGit;
}): Promise<RollbackLiveResult>;
/**
 * Make the live git checkout match the validated staging build:
 * snapshot live lib/dist (gitignored) → checkout tag → copy staging artifacts →
 * relink. On any post-checkout failure: `git checkout -f previousRef` + restore snapshot.
 */
export declare function promoteGithubStagingToLive(input: {
    liveRoot: string;
    stagingRoot: string;
    targetVersion: string;
    targetTag?: string;
    /**
     * Directory to snapshot live `lib/` + `apps/web/dist` into before checkout.
     * Required for safe rollback because those paths are gitignored in Harness.
     */
    artifactBackupRoot?: string;
    runGit: RunGit;
    /** Required: e.g. `pnpm install --ignore-scripts` in liveRoot after libs are copied. */
    relinkLive: (liveRoot: string) => Promise<void>;
}): Promise<PromoteResult>;
//# sourceMappingURL=github-promote.d.ts.map
