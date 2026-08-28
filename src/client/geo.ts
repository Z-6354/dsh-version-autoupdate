import {
  CAPSULE_EST_H,
  CAPSULE_W,
  DEFAULT_RIGHT,
  DEFAULT_TOP,
  PANEL_EST_H,
  PANEL_GAP,
  PANEL_MAX_H,
  PANEL_W,
  VIEW_MARGIN,
} from './constants';
import type { PanelLayout, Point } from './types';

export function defaultPos(): Point {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  return { left: vw - DEFAULT_RIGHT - CAPSULE_W, top: DEFAULT_TOP };
}

export function panelEstH(): number {
  return Math.min(PANEL_MAX_H, PANEL_EST_H);
}

export function computeBBox(
  left: number,
  top: number,
  capW: number,
  expanded: boolean,
  openUp: boolean,
  panelH: number,
): { left: number; top: number; width: number; height: number } {
  const gap = expanded ? PANEL_GAP : 0;
  const ph = expanded ? panelH : 0;
  const w = expanded ? Math.max(capW, PANEL_W) : capW;
  const bboxLeft = expanded && PANEL_W > capW ? left + capW - PANEL_W : left;
  let bboxTop = top;
  let bboxHeight = CAPSULE_EST_H;
  if (expanded) {
    if (openUp) {
      bboxTop = top - ph - gap;
      bboxHeight = CAPSULE_EST_H + ph + gap;
    } else {
      bboxHeight = CAPSULE_EST_H + gap + ph;
    }
  }
  return { left: bboxLeft, top: bboxTop, width: w, height: bboxHeight };
}

export function clampPoint(
  left: number,
  top: number,
  capW: number,
  expanded: boolean,
  openUp: boolean,
  panelH: number,
): Point {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bbox = computeBBox(left, top, capW, expanded, openUp, panelH);
  let dx = 0;
  let dy = 0;
  if (bbox.left < VIEW_MARGIN) dx = VIEW_MARGIN - bbox.left;
  if (bbox.left + bbox.width > vw - VIEW_MARGIN) dx = vw - VIEW_MARGIN - bbox.left - bbox.width;
  if (bbox.top < VIEW_MARGIN) dy = VIEW_MARGIN - bbox.top;
  if (bbox.top + bbox.height > vh - VIEW_MARGIN) dy = vh - VIEW_MARGIN - bbox.top - bbox.height;
  return { left: left + dx, top: top + dy };
}

export function shouldOpenUp(top: number, panelH: number): boolean {
  const spaceBelow = window.innerHeight - top - CAPSULE_EST_H - VIEW_MARGIN;
  const spaceAbove = top - VIEW_MARGIN;
  const need = panelH + PANEL_GAP;
  return spaceBelow < need && spaceAbove > spaceBelow;
}

export function computePanelMaxH(top: number, openUp: boolean, estH: number): number {
  const space = openUp
    ? top - VIEW_MARGIN
    : window.innerHeight - top - CAPSULE_EST_H - PANEL_GAP - VIEW_MARGIN;
  return Math.max(120, Math.min(estH, Math.floor(space)));
}

/** Layout for a capsule top-left at (top) with optional expanded panel. */
export function resolvePanelLayout(top: number, expanded: boolean): PanelLayout {
  const estH = panelEstH();
  const openUp = expanded && shouldOpenUp(top, estH);
  const panelMaxH = expanded ? computePanelMaxH(top, openUp, estH) : estH;
  return { openUp, panelMaxH };
}

export function clampIfNeeded(
  point: Point,
  capW: number,
  expanded: boolean,
  layout: PanelLayout,
): Point {
  const clamped = clampPoint(point.left, point.top, capW, expanded, layout.openUp, layout.panelMaxH);
  if (clamped.left === point.left && clamped.top === point.top) return point;
  return clamped;
}
