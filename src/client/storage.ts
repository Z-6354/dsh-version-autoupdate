import { LS_COLLAPSED, LS_DISMISS_KEY, LS_POS, CAPSULE_W } from './constants';
import { clampPoint, defaultPos } from './geo';
import type { Point } from './types';

export function readPos(): Point {
  try {
    const raw = localStorage.getItem(LS_POS);
    if (!raw) return defaultPos();
    const o = JSON.parse(raw) as { left?: number; top?: number; right?: number; x?: number; y?: number };
    if (typeof o.left === 'number' && typeof o.top === 'number') {
      return clampPoint(o.left, o.top, CAPSULE_W, false, false, 0);
    }
    if (typeof o.right === 'number' && typeof o.top === 'number') {
      const left = window.innerWidth - o.right - CAPSULE_W;
      return clampPoint(left, o.top, CAPSULE_W, false, false, 0);
    }
    if (typeof o.x === 'number' && typeof o.y === 'number') {
      return clampPoint(o.x, o.y, CAPSULE_W, false, false, 0);
    }
  } catch { /* ignore */ }
  return defaultPos();
}

export function writePos(p: Point): void {
  try { localStorage.setItem(LS_POS, JSON.stringify(p)); } catch { /* ignore */ }
}

export function readCollapsed(): boolean {
  try {
    const v = localStorage.getItem(LS_COLLAPSED);
    if (v === '0') return false;
  } catch { /* ignore */ }
  return true;
}

export function writeCollapsed(v: boolean): void {
  try { localStorage.setItem(LS_COLLAPSED, v ? '1' : '0'); } catch { /* ignore */ }
}

export function readDismissedKey(): string {
  try {
    return String(localStorage.getItem(LS_DISMISS_KEY) || '');
  } catch {
    return '';
  }
}

export function writeDismissedKey(key: string): void {
  try {
    // Never wipe a persisted dismiss with empty warrant (race before first status).
    if (!key) return;
    localStorage.setItem(LS_DISMISS_KEY, key);
  } catch { /* ignore */ }
}

export function clearDismissedKey(): void {
  try { localStorage.removeItem(LS_DISMISS_KEY); } catch { /* ignore */ }
}
