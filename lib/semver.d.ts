export declare function semverParts(s: string): {
    nums: number[];
    pre: string[];
} | null;
/** Minimal semver compare specialised for DSH versions (x.y.z and -rc.N). */
export declare function versionCompare(a: string, b: string): number;
export declare function isPrereleaseVersion(v: string): boolean;
export declare function isNewer(installed: string, latest: string): boolean;
//# sourceMappingURL=semver.d.ts.map