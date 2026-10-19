import * as React from 'react';
import { patchClientUiState } from './ui-store';
import { writeCollapsed } from './storage';
export function usePanelState(initialExpanded) {
    const [expanded, setExpanded] = React.useState(initialExpanded);
    const [userDismissed, setUserDismissed] = React.useState(false);
    const expandPanel = React.useCallback(() => {
        setExpanded(true);
        writeCollapsed(false);
        patchClientUiState({ panelOpen: true });
        setUserDismissed(false);
    }, []);
    const collapsePanel = React.useCallback((dismiss = false) => {
        setExpanded(false);
        writeCollapsed(true);
        patchClientUiState({ panelOpen: false });
        if (dismiss)
            setUserDismissed(true);
    }, []);
    const toggleExpanded = React.useCallback((wasDragged, resetDrag) => {
        if (wasDragged) {
            resetDrag();
            return;
        }
        setExpanded((prev) => {
            const next = !prev;
            writeCollapsed(!next);
            patchClientUiState({ panelOpen: next });
            if (!next)
                setUserDismissed(true);
            return next;
        });
    }, []);
    return {
        expanded,
        userDismissed,
        setUserDismissed,
        expandPanel,
        collapsePanel,
        toggleExpanded,
    };
}
//# sourceMappingURL=panel-state.js.map