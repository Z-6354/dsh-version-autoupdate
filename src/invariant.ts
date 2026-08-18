/**
 * Runtime invariant assertions used across the package. Fatal conditions throw
 * here so failures surface instead of silently degrading.
 */
export function invariant(condition: unknown, message?: string): asserts condition {
  if (!condition) {
    throw new Error(message ?? 'dsh-version-autoupdate invariant failed');
  }
}
