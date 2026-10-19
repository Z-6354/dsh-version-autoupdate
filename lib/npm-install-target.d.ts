import type { Context } from "@deepseek-ai/cordis";
export declare function verifyNpmInstallTarget(ctx: Context, pm: string, runningRoot: string): Promise<string>;
export declare function readVerifiedInstalledVersion(root: string, targetVersion: string): string;
