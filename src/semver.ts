export function semverParts(s: string): { nums: number[]; pre: string[] } | null {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/^v/i, '');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(t);
  if (!match) return null;
  const nums = match.slice(1, 4).map(Number);
  const pre = match[4]?.split('.') ?? [];
  if (nums.some((x) => !Number.isSafeInteger(x))) return null;
  if (pre.some((x) => /^\d+$/.test(x) && x.length > 1 && x[0] === '0')) return null;
  return { nums, pre };
}

/** Minimal semver compare specialised for DSH versions (x.y.z and -rc.N). */
export function versionCompare(a: string, b: string): number {
  const x = semverParts(a);
  const y = semverParts(b);
  if (!x || !y) return a < b ? -1 : a > b ? 1 : 0;
  const n = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < n; i++) {
    const xv = x.nums[i] || 0;
    const yv = y.nums[i] || 0;
    if (xv !== yv) return xv < yv ? -1 : 1;
  }
  if (x.pre.length && !y.pre.length) return -1;
  if (!x.pre.length && y.pre.length) return 1;
  const m = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < m; i++) {
    if (i >= x.pre.length) return -1;
    if (i >= y.pre.length) return 1;
    const xp = x.pre[i]!;
    const yp = y.pre[i]!;
    if (xp === yp) continue;
    const xn = /^\d+$/.test(xp) ? parseInt(xp, 10) : NaN;
    const yn = /^\d+$/.test(yp) ? parseInt(yp, 10) : NaN;
    if (!Number.isNaN(xn) && !Number.isNaN(yn)) {
      if (xp.length !== yp.length) return xp.length < yp.length ? -1 : 1;
      if (xp !== yp) return xp < yp ? -1 : 1;
      continue;
    }
    if (!Number.isNaN(xn)) return -1;
    if (!Number.isNaN(yn)) return 1;
    if (xp !== yp) return xp < yp ? -1 : 1;
  }
  return 0;
}

export function isPrereleaseVersion(v: string): boolean {
  const parts = semverParts(v);
  return !!parts && parts.pre.length > 0;
}

export function isNewer(installed: string, latest: string): boolean {
  return versionCompare(installed, latest) < 0;
}
