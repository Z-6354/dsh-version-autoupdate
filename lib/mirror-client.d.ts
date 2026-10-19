export type Transport = 'auto' | 'mirror' | 'official';
export type InstallationSource = 'npm' | 'github';
export interface VersionResult {
    source: InstallationSource;
    version: string;
    tag?: string;
    transport: 'mirror' | 'official';
    cached?: boolean;
}
export interface ArtifactResult {
    source: InstallationSource;
    version: string;
    transport: 'mirror' | 'official';
    data: Uint8Array;
    sha256: string;
    tag?: string;
    /** True when bytes came from ~/.dsh/version-autoupdate/cache (no network body). */
    fromCache?: boolean;
}
export interface DownloadProgress {
    bytesDownloaded: number;
    bytesTotal: number | null;
}
export interface MirrorClientOptions {
    fetch?: typeof globalThis.fetch;
    password?: string | null;
    mirrorBase?: string;
    npmPackage?: string;
    githubRepository?: string;
    maxDownloadBytes?: number;
    /** Reject archives smaller than this (default 1024). Set 0 in tests with tiny fixtures. */
    minDownloadBytes?: number;
}
export type MirrorErrorKind = 'network' | 'auth' | 'response' | 'integrity' | 'source' | 'archive';
export declare class MirrorClientError extends Error {
    readonly kind: MirrorErrorKind;
    readonly retryable: boolean;
    constructor(message: string, kind: MirrorErrorKind, retryable: boolean, options?: {
        cause?: unknown;
    });
}
interface RequestOptions {
    repository?: string;
    expectedSha256?: string;
    tag?: string;
    onProgress?: (progress: DownloadProgress) => void | Promise<void>;
    /**
     * DSH home (or autoupdate parent). When set for GitHub downloads, reuse a
     * validated local archive and resume `.partial` via HTTP Range.
     */
    artifactCacheHome?: string;
}
export declare class MirrorClient {
    private readonly fetchImpl;
    private readonly options;
    constructor(options?: MirrorClientOptions);
    getLatest(source: InstallationSource, transport: Transport, request?: RequestOptions): Promise<VersionResult>;
    download(source: InstallationSource, version: string, transport: Transport, request?: RequestOptions): Promise<ArtifactResult>;
    private request;
    private getMirrorLatest;
    private getOfficialLatest;
    private downloadMirror;
    private downloadOfficial;
    private downloadResponse;
    private downloadResponseCached;
}
/** Prefer Host web for public JSON; native fetch for mirror (auth) and binary archives. */
export declare function createMirrorClientFromContext(ctx: {
    get(name: string): unknown;
}, options?: Omit<MirrorClientOptions, 'fetch'>): MirrorClient;
export {};
//# sourceMappingURL=mirror-client.d.ts.map