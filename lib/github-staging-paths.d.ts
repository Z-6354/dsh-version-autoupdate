/** Default cap for GitHub archive downloads (512 MiB). */
export declare const MAX_GITHUB_DOWNLOAD_BYTES: number;
export declare function resolveAutoupdateHome(explicit?: string, env?: Record<string, string | undefined>): string;
export declare function stagingDir(home: string, operationId: string): string;
export declare function backupDir(home: string, operationId: string): string;
export declare function restartOutcomePath(home?: string): string;
export declare function promoteJobPath(home?: string): string;
export declare function maintenancePath(home?: string): string;
//# sourceMappingURL=github-staging-paths.d.ts.map