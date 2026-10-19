/** Minimum Node for DSH global installs (matches harness engine floor). */
export declare const MIN_NODE_FOR_DSH = "22.19.0";
/** Derive the Node install prefix from a global @deepseek-ai/dsh package root. */
export declare function nodePrefixFromDshRoot(root: string): string | null;
export interface PackageManagerEnvOpts {
    nodeBinDir?: string;
    platform?: NodeJS.Platform | string;
    env?: NodeJS.ProcessEnv;
    /** Override home (tests). Default: HOME / USERPROFILE / os.homedir(). */
    home?: string | null;
    /** Windows %APPDATA% (npm global shims). */
    appData?: string | null;
    /** Windows %LOCALAPPDATA% (standalone pnpm / PNPM_HOME default). */
    localAppData?: string | null;
}
export interface PackageManagerSearchOpts extends PackageManagerEnvOpts {
    dshRoot: string | null;
    pm: string;
    nodeBinDir: string;
    platform: NodeJS.Platform | string;
}
/**
 * Extra bin directories that interactive shells often have on PATH,
 * but GUI / Watchdog-launched DSH Host may not (Windows + Linux + macOS).
 */
export declare function packageManagerExtraBinDirs(opts?: PackageManagerEnvOpts): string[];
/** Ordered executable paths to try before falling back to PATH lookup. */
export declare function packageManagerSearchPaths(opts: PackageManagerSearchOpts): string[];
/** Prefer an existing PYTHON, else common Windows installs (node-gyp / pnpm rebuild). */
export declare function resolveWindowsPythonPath(env?: NodeJS.ProcessEnv, fileExists?: (path: string) => boolean): string | null;
/** Build subprocess env so package managers prefer the Node that runs DSH. */
export declare function buildInstallEnv(nodeBinDir?: string, opts?: PackageManagerEnvOpts): NodeJS.ProcessEnv;
/** How to invoke pnpm on any platform (direct binary or via corepack). */
export interface ResolvedPnpm {
    /** Absolute or PATH-resolved executable (pnpm / pnpm.cmd / corepack / node). */
    exe: string;
    /** Args inserted before install/run, e.g. `['pnpm']` when exe is corepack. */
    prefixArgs: string[];
}
export declare function isCorepackInvocation(pnpm: ResolvedPnpm): boolean;
/**
 * Locate the Node entry script behind an npm-global Windows `.cmd` shim.
 * Node 20+ refuses to spawn `.cmd`/`.bat` without a shell (EINVAL); DSH Host
 * subprocess never uses a shell, so we must unwrap to `node + script`.
 */
export declare function resolveWindowsCmdNodeEntry(cmdPath: string, fileExists?: (path: string) => boolean): string | null;
export type SpawnablePnpmOpts = {
    platform?: string;
    nodeExe?: string;
    comSpec?: string;
    fileExists?: (path: string) => boolean;
};
/** True when argv[0] is a Windows batch shim that Node/Host cannot spawn without a shell. */
export declare function isWindowsBatchShim(exe: string | null | undefined): boolean;
/**
 * Host subprocess never shell-interprets argv (see dsh-subprocess types).
 * Calling this before every Host spawn turns cryptic `spawn EINVAL` into an actionable error.
 */
export declare function assertHostSpawnableArgv(argv: readonly string[], platform?: string): void;
/**
 * Convert a resolved pnpm/corepack invocation into something Host subprocess
 * can spawn on Windows (no shell) and Linux.
 */
export declare function makeSpawnablePnpm(pnpm: ResolvedPnpm, opts?: SpawnablePnpmOpts): ResolvedPnpm;
export declare function formatPnpmArgv(pnpm: ResolvedPnpm, args: string[], opts?: SpawnablePnpmOpts): string[];
/** Spawn argv for an arbitrary Windows .cmd tool (e.g. corepack prepare / npm.cmd). */
export declare function formatToolArgv(exe: string, args: string[], opts?: SpawnablePnpmOpts): string[];
/** User-facing remediation when pnpm cannot be resolved or verified (Windows + Linux). */
export declare function formatPnpmRemediationError(input: {
    platform?: string;
    detail?: string | null;
    tried?: string[];
}): string;
export type PnpmSpawnResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};
export type PnpmSpawnFn = (argv: string[], env: NodeJS.ProcessEnv, cwd?: string) => Promise<PnpmSpawnResult>;
/**
 * Resolve + verify pnpm. If corepack exists but pnpm is inactive, run
 * `corepack prepare pnpm@latest --activate` once and re-resolve.
 * Call this before downloading a GitHub archive (fail fast).
 */
export declare function ensurePnpmReady(input: {
    resolveExecutable: (cmd: string, env?: Readonly<Record<string, string>>) => Promise<string>;
    spawn: PnpmSpawnFn;
    explicitPath?: string | null;
    nodeBinDir?: string;
    platform?: NodeJS.Platform | string;
    env?: NodeJS.ProcessEnv;
    home?: string | null;
    appData?: string | null;
    localAppData?: string | null;
    nodeExe?: string;
    comSpec?: string;
    fileExists?: (path: string) => boolean;
    onProgress?: (message: string) => void | Promise<void>;
}): Promise<ResolvedPnpm & {
    version: string;
}>;
/**
 * Resolve a pnpm invocation for GitHub staging builds.
 * Works on Windows and Linux/macOS: node-adjacent shims, user global bins, PNPM_HOME, then corepack.
 */
export declare function resolvePnpmExecutable(input: {
    resolveExecutable: (cmd: string, env?: Readonly<Record<string, string>>) => Promise<string>;
    explicitPath?: string | null;
    nodeBinDir?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string | null;
    appData?: string | null;
    localAppData?: string | null;
}): Promise<ResolvedPnpm>;
export declare function runningNodeSatisfiesDsh(version?: string): {
    ok: true;
    version: string;
} | {
    ok: false;
    version: string;
    message: string;
};
/** argv for `npm|pnpm|yarn install -g @deepseek-ai/dsh@<version>`. */
export declare function buildGlobalInstallArgv(pmExe: string, version: string): string[];
/** Rough preflight for npm global install on small VPS hosts (Linux only). */
export declare function lowMemoryInstallWarning(availableMb: number | null, thresholdMb?: number): string | null;
//# sourceMappingURL=package-manager.d.ts.map