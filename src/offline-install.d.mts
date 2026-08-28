export function dshStateDir(): string;
export function offlineLogFile(): string;
export function offlineStateFile(): string;
export function readOfflineState(): unknown;
export function writeOfflineState(state: unknown): void;
export function readLinuxMemTotalMb(): number | null;
export function shouldUseOfflineInstall(cfg?: Record<string, unknown>, memTotalMb?: number | null): boolean;
export function buildOfflineInstallShell(parts: {
  unit: string;
  npmCmd: string;
  version: string;
  dshPid: number;
  logFile: string;
  stateFile: string;
  plan: { exe: string; args: string[]; cwd: string; port: number; mode: string };
  nodeBin: string;
}): string;
export function scheduleOfflineInstall(opts: {
  pmExe: string;
  npmArgv: string[];
  version: string;
  before?: string | null;
  cfg?: Record<string, unknown>;
  dshPid?: number;
}): {
  ok: boolean;
  offline: boolean;
  logFile: string;
  stateFile: string;
  scriptPath: string;
  message: string;
};
