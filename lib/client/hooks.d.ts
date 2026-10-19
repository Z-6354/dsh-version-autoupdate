import * as React from 'react';
export declare function useCapsulePos(expanded: boolean): {
    pos: any;
    layout: any;
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    wasDragged: () => any;
    resetDrag: () => void;
};
import { getClientUiState } from './ui-store';
export declare function useClientUi(): ReturnType<typeof getClientUiState>;
//# sourceMappingURL=hooks.d.ts.map