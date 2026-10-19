import type { Context } from '@deepseek-ai/cordis';
export type { InstallationSource } from './source-detection.js';
export { detectInstallationSource, normalizeGitHubTag } from './source-detection.js';
/** Map a resolved `dsh` executable path to the installed package root. */
export declare function dshRootFromExecutable(exe: string): string | null;
/** Locate the installed DSH package root (global npm, harness checkout, or known deploy paths). */
export declare function findDshRoot(ctx: Context): Promise<string | null>;
//# sourceMappingURL=dsh-root.d.ts.map