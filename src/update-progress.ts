import type { UpdatePhase } from './update-types.js';

export function estimateInstallProgress(
  phase: UpdatePhase,
  startedAt: number | null,
  tail: string,
  installTimeoutMs = 1_200_000,
): number {
  if (phase === 'checking') return 15;
  if (phase === 'check-done') return 33;
  if (phase === 'install-done') return 85;
  if (phase === 'restarting') return 96;
  if (phase === 'done') return 100;
  if (phase === 'error') return 5;
  if (phase !== 'installing') return 0;
  const elapsed = startedAt ? Date.now() - startedAt : 0;
  const tailBoost = Math.min(35, (tail.match(/\n/g) || []).length * 2);
  const tickMs = Math.max(2000, Math.floor(installTimeoutMs / 150));
  const timeBoost = Math.min(45, Math.floor(elapsed / tickMs) * 4);
  return Math.min(82, 38 + tailBoost + timeBoost);
}
