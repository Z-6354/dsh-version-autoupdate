import { LS_COLLAPSED, LS_POS, CAPSULE_W } from './constants';
import { clampPoint, defaultPos } from './geo';
export function readPos() {
    try {
        const raw = localStorage.getItem(LS_POS);
        if (!raw)
            return defaultPos();
        const o = JSON.parse(raw);
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
    }
    catch { /* ignore */ }
    return defaultPos();
}
export function writePos(p) {
    try {
        localStorage.setItem(LS_POS, JSON.stringify(p));
    }
    catch { /* ignore */ }
}
export function readCollapsed() {
    try {
        const v = localStorage.getItem(LS_COLLAPSED);
        if (v === '0')
            return false;
    }
    catch { /* ignore */ }
    return true;
}
export function writeCollapsed(v) {
    try {
        localStorage.setItem(LS_COLLAPSED, v ? '1' : '0');
    }
    catch { /* ignore */ }
}
//# sourceMappingURL=storage.js.map