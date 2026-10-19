import * as React from 'react';
import { DRAG_THRESHOLD, CAPSULE_W } from './constants';
import { clampPoint, resolvePanelLayout } from './geo';
import { readPos, writePos } from './storage';
export function useCapsulePos(expanded) {
    const [pos, setPos] = React.useState(() => readPos());
    const capWRef = React.useRef(CAPSULE_W);
    const dragRef = React.useRef({
        active: false,
        moved: false,
        pointerId: -1,
        startX: 0,
        startY: 0,
        offsetX: 0,
        offsetY: 0,
    });
    const layout = resolvePanelLayout(pos.top, expanded);
    React.useLayoutEffect(() => {
        setPos((p) => {
            const next = clampPoint(p.left, p.top, capWRef.current, expanded, layout.openUp, layout.panelMaxH);
            if (next.left === p.left && next.top === p.top)
                return p;
            return next;
        });
    }, [expanded, layout.openUp, layout.panelMaxH]);
    const onPointerDown = (e) => {
        if (e.button !== 0)
            return;
        const el = e.currentTarget;
        const rect = el.getBoundingClientRect();
        capWRef.current = rect.width;
        dragRef.current = {
            active: true,
            moved: false,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
        };
        e.preventDefault();
    };
    const onPointerMove = (e) => {
        const d = dragRef.current;
        if (!d.active || d.pointerId !== e.pointerId)
            return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD)
            return;
        d.moved = true;
        const left = e.clientX - d.offsetX;
        const top = e.clientY - d.offsetY;
        const liveLayout = resolvePanelLayout(top, expanded);
        const next = clampPoint(left, top, capWRef.current, expanded, liveLayout.openUp, liveLayout.panelMaxH);
        setPos(next);
    };
    const onPointerUp = (e) => {
        const d = dragRef.current;
        if (!d.active || d.pointerId !== e.pointerId)
            return;
        d.active = false;
        d.pointerId = -1;
        if (d.moved) {
            setPos((p) => {
                writePos(p);
                return p;
            });
        }
    };
    return {
        pos,
        layout,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        wasDragged: () => dragRef.current.moved,
        resetDrag: () => { dragRef.current.moved = false; },
    };
}
import { getClientUiState, subscribeClientUiState } from './ui-store';
export function useClientUi() {
    const [, bump] = React.useState(0);
    React.useEffect(() => subscribeClientUiState(() => bump((n) => n + 1)), []);
    return getClientUiState();
}
//# sourceMappingURL=hooks.js.map