import * as React from 'react';
import { request } from './api';
import { useClientUi } from './hooks';
import { getClientUiState, patchClientUiState } from './ui-store';
import { autoExpandResetKey, shouldAutoExpand } from './status';
import { readDismissedKey } from './storage';
import type { DshStatus } from './types';

export interface RefreshResult {
  next: DshStatus;
  waiting: boolean;
  shouldExpand: boolean;
  resetKey: string;
}

export function useVersionStatus(userDismissed: boolean) {
  const [st, setSt] = React.useState<DshStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [lastRefresh, setLastRefresh] = React.useState<RefreshResult | null>(null);
  const dismissKeyRef = React.useRef(readDismissedKey());
  const ui = useClientUi();

  const refreshSeq = React.useRef(0);

  const refresh = React.useCallback(() => {
    const seq = ++refreshSeq.current;
    return request('/dsh-version-updater/status')
      .then((r) => {
        if (seq !== refreshSeq.current) return null;
        const next = r as DshStatus;
        const waiting = getClientUiState().waitingReconnect;
        patchClientUiState({ waitingReconnect: false });
        setSt(next);

        if (next.update?.restartScheduled) patchClientUiState({ restartWatch: true, pollActive: true });
        if (next.update?.running) patchClientUiState({ pollActive: true, panelOpen: true });
        if (next.update?.phase === 'error' && !next.update?.running) {
          patchClientUiState({ pollActive: false, restartWatch: false });
        }

        const resetKey = autoExpandResetKey(next, waiting);
        const result: RefreshResult = {
          next,
          waiting,
          shouldExpand: shouldAutoExpand(next, waiting, userDismissed),
          resetKey,
        };
        setLastRefresh(result);

        if (next.status === 'up-to-date' && !next.update?.running && !next.moduleUpdateAvailable) {
          patchClientUiState({ pollActive: false, restartWatch: false });
        }

        return result;
      })
      .catch(() => {
        if (seq !== refreshSeq.current) return null;
        if (getClientUiState().restartWatch) patchClientUiState({ waitingReconnect: true, pollActive: true });
        return null;
      });
  }, [userDismissed]);

  React.useEffect(() => {
    refresh();
    const id = setInterval(() => void refresh(), 60000);
    return () => clearInterval(id);
  }, [refresh]);

  const upd = st?.update;
  const phase = upd?.phase ?? 'idle';
  const running = !!upd?.running;
  const waitingReconnect = ui.waitingReconnect;
  const needsFastPoll = ui.pollActive || busy || waitingReconnect || running || !!upd?.restartScheduled ||
    phase === 'checking' || phase === 'installing' || phase === 'restarting';

  React.useEffect(() => {
    if (!needsFastPoll) return;
    const id = setInterval(() => void refresh(), waitingReconnect ? 1200 : 600);
    return () => clearInterval(id);
  }, [needsFastPoll, waitingReconnect, refresh]);

  const postStep = React.useCallback((path: string, onExpand: () => void, watchRestart = false) => {
    if (busy || running) return;
    onExpand();
    setBusy(true);
    patchClientUiState({
      pollActive: true,
      panelOpen: true,
      restartWatch: watchRestart || getClientUiState().restartWatch,
    });
    if (watchRestart) patchClientUiState({ waitingReconnect: true });
    request(path).then(() => refresh()).catch(() => refresh()).finally(() => setBusy(false));
  }, [busy, running, refresh]);

  return {
    st,
    busy,
    upd,
    phase,
    running,
    waitingReconnect,
    needsFastPoll,
    refresh,
    postStep,
    lastRefresh,
    dismissKeyRef,
  };
}
