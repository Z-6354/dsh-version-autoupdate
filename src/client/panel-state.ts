import * as React from 'react';
import { patchClientUiState } from './ui-store';
import { writeCollapsed, writeDismissedKey, readDismissedKey } from './storage';

export function usePanelState(initialExpanded: boolean) {
  const [expanded, setExpanded] = React.useState(initialExpanded);
  /** Prefer collapsed after restart until a *new* warrant key appears. */
  const [userDismissed, setUserDismissed] = React.useState(() => !initialExpanded);
  const warrantKeyRef = React.useRef(readDismissedKey());

  const setWarrantKey = React.useCallback((key: string) => {
    if (key) warrantKeyRef.current = key;
  }, []);

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
    if (dismiss) {
      setUserDismissed(true);
      writeDismissedKey(warrantKeyRef.current);
    }
  }, []);

  const toggleExpanded = React.useCallback((wasDragged: boolean, resetDrag: () => void) => {
    if (wasDragged) {
      resetDrag();
      return;
    }
    setExpanded((prev) => {
      const next = !prev;
      writeCollapsed(!next);
      patchClientUiState({ panelOpen: next });
      if (!next) {
        setUserDismissed(true);
        writeDismissedKey(warrantKeyRef.current);
      } else {
        setUserDismissed(false);
      }
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
    setWarrantKey,
  };
}
