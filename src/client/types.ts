export interface Point {
  left: number;
  top: number;
}

export interface Capabilities {
  canDetect: boolean;
  canInstall: boolean;
  canRestart: boolean;
  detectOnlyReason: string;
}

export interface SystemInfo {
  os: string;
  arch: string;
  node: string;
  installMethod: string;
  packageManager?: string;
}

export interface DshStatus {
  runningVersion: string | null;
  installedVersion?: string | null;
  latestVersion: string | null;
  stableLatest?: string | null;
  previewLatest?: string | null;
  channel?: 'stable' | 'preview';
  note?: string;
  status: string;
  platform?: string;
  autoRestart?: boolean;
  restartHint?: string;
  capabilities?: Capabilities;
  system?: SystemInfo | null;
  moduleName?: string;
  moduleVersion?: string | null;
  moduleLatestVersion?: string | null;
  moduleUpdateAvailable?: boolean;
  update?: {
    phase: string;
    failedStep?: string | null;
    running: boolean;
    message: string;
    tail: string;
    progress?: number;
    progressLabel?: string;
    restartScheduled?: boolean;
  } | null;
}

export interface PanelLayout {
  openUp: boolean;
  panelMaxH: number;
}
