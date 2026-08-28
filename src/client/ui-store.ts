export interface ClientUiState {
  pollActive: boolean;
  panelOpen: boolean;
  waitingReconnect: boolean;
  restartWatch: boolean;
}

const clientUi: ClientUiState = {
  pollActive: false,
  panelOpen: false,
  waitingReconnect: false,
  restartWatch: false,
};

const uiListeners = new Set<() => void>();

export function getClientUiState(): ClientUiState {
  return clientUi;
}

export function patchClientUiState(patch: Partial<ClientUiState>): void {
  let changed = false;
  for (const k of Object.keys(patch) as (keyof ClientUiState)[]) {
    if (patch[k] !== undefined && clientUi[k] !== patch[k]) {
      (clientUi as unknown as Record<string, unknown>)[k] = patch[k];
      changed = true;
    }
  }
  if (changed) for (const fn of uiListeners) fn();
}

export function subscribeClientUiState(fn: () => void): () => void {
  uiListeners.add(fn);
  return () => uiListeners.delete(fn);
}
