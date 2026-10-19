import type { PanelLayout, Point } from './types';
export declare function defaultPos(): Point;
export declare function panelEstH(): number;
export declare function computeBBox(left: number, top: number, capW: number, expanded: boolean, openUp: boolean, panelH: number): {
    left: number;
    top: number;
    width: number;
    height: number;
};
export declare function clampPoint(left: number, top: number, capW: number, expanded: boolean, openUp: boolean, panelH: number): Point;
export declare function shouldOpenUp(top: number, panelH: number): boolean;
export declare function computePanelMaxH(top: number, openUp: boolean, estH: number): number;
/** Layout for a capsule top-left at (top) with optional expanded panel. */
export declare function resolvePanelLayout(top: number, expanded: boolean): PanelLayout;
export declare function clampIfNeeded(point: Point, capW: number, expanded: boolean, layout: PanelLayout): Point;
//# sourceMappingURL=geo.d.ts.map