export function semverParts(s: string): { nums: number[]; pre: string[] } | null {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/^v/i, '');
  const dash = t.indexOf('-');
  const main = dash >= 0 ? t.slice(0, dash) : t;
  const pre = dash >= 0 ? t.slice(dash + 1).split('.') : [];
  const nums = main.split('.').map((x) => parseInt(x, 10));
  if (nums.length === 0 || nums.some((x) => Number.isNaN(x))) return null;
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
    const xp = x.pre[i] || '';
    const yp = y.pre[i] || '';
    if (xp === yp) continue;
    const xn = /^\d+$/.test(xp) ? parseInt(xp, 10) : NaN;
    const yn = /^\d+$/.test(yp) ? parseInt(yp, 10) : NaN;
    if (!Number.isNaN(xn) && !Number.isNaN(yn)) {
      if (xn !== yn) return xn < yn ? -1 : 1;
      continue;
    }
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
