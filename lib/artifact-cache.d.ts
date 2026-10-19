export interface GithubArtifactMeta {
    source: 'github';
    version: string;
    tag: string;
    transport: 'mirror' | 'official';
    sha256: string;
    bytes: number;
    completedAt: string;
}
export interface GithubCachePaths {
    dir: string;
    archive: string;
    partial: string;
    partialMeta: string;
    meta: string;
}
export declare function githubArtifactPaths(home: string, version: string): GithubCachePaths;
/**
 * Partial files are transport-specific (mirror vs official URLs differ).
 * Switching channel drops the incomplete file so Range resume cannot mix bytes.
 */
export declare function preparePartialForTransport(home: string, version: string, transport: 'mirror' | 'official'): Promise<void>;
export declare function clearGithubArtifactVersion(home: string, version: string): Promise<void>;
export declare function partialByteLength(home: string, version: string): Promise<number>;
/** Return complete cached archive when meta + sha256 verify; otherwise null. */
export declare function loadCompleteGithubArtifact(home: string, version: string, expectedTag?: string): Promise<{
    version: string;
    tag: string;
    transport: 'mirror' | 'official';
    data: Uint8Array;
    sha256: string;
} | null>;
export declare function commitGithubArtifact(home: string, artifact: {
    version: string;
    tag: string;
    transport: 'mirror' | 'official';
    data: Uint8Array;
    sha256: string;
}): Promise<void>;
/** Append or replace partial file; returns total bytes on disk after write. */
export declare function writePartialChunk(home: string, version: string, chunk: Uint8Array, mode: 'append' | 'replace'): Promise<number>;
export declare function readPartialFile(home: string, version: string): Promise<Uint8Array>;
//# sourceMappingURL=artifact-cache.d.ts.map