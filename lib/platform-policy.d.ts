/** How the updater behaves per deployment. */
export type UpdatePolicy = 'platform' | 'full' | 'detect-only';
export interface UpdateCapabilities {
    /** Registry / version polling (always on). */
    canDetect: boolean;
    /** npm install -g and related write operations. */
    canInstall: boolean;
    /** Process restart to load new build. */
    canRestart: boolean;
    /** Human-readable reason when install/restart are blocked. */
    detectOnlyReason: string;
}
/**
 * Default: Windows → full update; Linux/macOS → detect-only (VPS safety).
 * Override with config.updatePolicy: 'full' | 'detect-only'.
 */
export declare function resolveUpdateCapabilities(platform: NodeJS.Platform, policy?: UpdatePolicy): UpdateCapabilities;
//# sourceMappingURL=platform-policy.d.ts.map