/** Installation origins supported by the updater. */
export type InstallationSource = 'npm' | 'github' | 'unknown';
/** Evidence collected for one candidate DSH installation root. */
export interface InstallationSourceInput {
    /** Candidate root, used for path normalization and diagnostics. */
    path?: string;
    /** Whether the candidate root contains a Git checkout. */
    hasGit?: boolean;
    /** Relative Harness source markers actually found below `path`. */
    sourceMarkers?: readonly string[];
    /** Git remote URL read from the candidate checkout. */
    remote?: string;
    /** Package metadata from the candidate root. */
    metadata?: {
        repository?: string;
        name?: string;
    };
}
/** Identifies a global npm DSH installation or a proven Harness GitHub checkout. */
export declare function detectInstallationSource(input: InstallationSourceInput): InstallationSource;
/** Converts supported DSH GitHub tags to a plain semver-like version. */
export declare function normalizeGitHubTag(tag: string): string | null;
//# sourceMappingURL=source-detection.d.ts.map