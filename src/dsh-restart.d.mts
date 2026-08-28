export function autoRestartEnabled(cfg?: Record<string, unknown>): boolean;
export function manualRestartHint(): string;
export function isRestartScheduled(): boolean;
export function scheduleProcessRestart(opts?: {
  reason?: string;
  delayMs?: number;
  cfg?: Record<string, unknown>;
  /** User-confirmed restart; bypasses autoRestart policy (e.g. Windows). */
  force?: boolean;
}): {
  ok?: boolean;
  skipped?: boolean;
  restartScheduled?: boolean;
  message?: string;
  error?: string;
  platform?: string;
};
export function maybeAutoRestart(
  reason: string,
  cfg?: Record<string, unknown>,
): {
  ok?: boolean;
  skipped?: boolean;
  needRestart?: boolean;
  restartScheduled?: boolean;
  message?: string;
  error?: string;
  platform?: string;
};
