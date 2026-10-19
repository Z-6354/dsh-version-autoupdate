import { MAX_GITHUB_DOWNLOAD_BYTES } from './github-staging-paths.js';
export { MAX_GITHUB_DOWNLOAD_BYTES };
export type ExtractTarGz = (data: Uint8Array, destDir: string) => Promise<void>;
/** Reject downloads larger than the configured cap. */
export declare function assertDownloadSize(size: number, maxBytes?: number): void;
/** GitHub archives must unpack to exactly one top-level directory. */
export declare function resolveExtractedRoot(extractDir: string): Promise<string>;
/** Validate Harness checkout layout, version, and optional tag. */
export declare function validateHarnessCheckout(root: string, expectedVersion: string, expectedTag?: string): Promise<void>;
export declare function extractTarGzDefault(data: Uint8Array, destDir: string): Promise<void>;
/** True when stderr only reports Windows symlink / invalid-argument create failures. */
export declare function isBenignWindowsTarNoise(stderr: string): boolean;
export declare function extractAndValidateGithubArchive(data: Uint8Array, extractDir: string, expectedVersion: string, expectedTag?: string, extract?: ExtractTarGz): Promise<string>;
//# sourceMappingURL=github-archive.d.ts.map