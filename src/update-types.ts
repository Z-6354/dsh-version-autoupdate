/** Wizard step (1=check, 2=install, 3=restart). */
export type UpdateStep = 'idle' | 'check' | 'install' | 'restart';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'check-done'
  | 'installing'
  | 'install-done'
  | 'restarting'
  | 'done'
  | 'error';

export interface UpdateState {
  running: boolean;
  phase: UpdatePhase;
  /** Current wizard step; mirrors phase for UI. */
  step: UpdateStep;
  /** Which step failed when phase === 'error'. */
  failedStep: UpdateStep | null;
  done: boolean;
  ok: boolean;
  message: string;
  tail: string;
  progress: number;
  progressLabel: string;
  progressSpeed: string;
  startedAt: number | null;
  restartScheduled: boolean;
  system: { os: string; arch: string; node: string; installMethod: string; packageManager?: string } | null;
  before: string | null;
  after: string | null;
  latest: string | null;
}

export const STEP_LABELS: Record<Exclude<UpdateStep, 'idle'>, string> = {
  check: '① 自动检测',
  install: '② 安装到本地',
  restart: '③ 确认重启',
};
