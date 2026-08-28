import * as React from 'react';
import { DRAG_THRESHOLD, CAPSULE_W } from './constants';
import { clampPoint, resolvePanelLayout } from './geo';
import { readPos, writePos } from './storage';
import { getClientUiState, subscribeClientUiState } from './ui-store';
import type { Point } from './types';

interface DragState {
  active: boolean;
  moved: boolean;
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

export function useClientUi(): ReturnType<typeof getClientUiState> {
  const [, bump] = React.useState(0);
  React.useEffect(() => subscribeClientUiState(() => bump((n) => n + 1)), []);
  return getClientUiState();
}

export function useCapsulePos(expanded: boolean) {
  const [pos, setPos] = React.useState<Point>(() => readPos());
  const capWRef = React.useRef(CAPSULE_W);
  const dragRef = React.useRef<DragState>({
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
      if (next.left === p.left && next.top === p.top) return p;
      writePos(next);
      return next;
    });
  }, [expanded, layout.openUp, layout.panelMaxH]);

  React.useEffect(() => {
    const onResize = () => {
      setPos((p) => {
        const live = resolvePanelLayout(p.top, expanded);
        const next = clampPoint(p.left, p.top, capWRef.current, expanded, live.openUp, live.panelMaxH);
        if (next.left === p.left && next.top === p.top) return p;
        writePos(next);
        return next;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [expanded]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
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
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.active || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    d.moved = true;
    const left = e.clientX - d.offsetX;
    const top = e.clientY - d.offsetY;
    const liveLayout = resolvePanelLayout(top, expanded);
    const next = clampPoint(left, top, capWRef.current, expanded, liveLayout.openUp, liveLayout.panelMaxH);
    setPos(next);
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.active || d.pointerId !== e.pointerId) return;
    d.active = false;
    d.pointerId = -1;
    const el = e.currentTarget as HTMLElement;
    try {
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    } catch { /* ignore */ }
    if (d.moved) {
      setPos((p) => {
        writePos(p);
        return p;
      });
      // Clear moved after click window so the next tap is not eaten if click was suppressed.
      window.setTimeout(() => { d.moved = false; }, 0);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => { endDrag(e); };
  const onPointerCancel = (e: React.PointerEvent) => { endDrag(e); };
  const onLostPointerCapture = (e: React.PointerEvent) => { endDrag(e); };

  return {
    pos,
    layout,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
    wasDragged: () => dragRef.current.moved,
    resetDrag: () => { dragRef.current.moved = false; },
  };
}
