/** How the updater behaves per deployment. */
export type UpdatePolicy = 'platform' | 'full' | 'detect-only';

export interface UpdateCapabilities {
  /** Registry / version polling (always on). */
  canDetect: boolean;
  /** npm install -g and related write operations. */
  canInstall: boolean;
  /** Process restart to load new build. */
  canRestart: boolean;
  /** Human-readable reason when install/restart are blocked. */
  detectOnlyReason: string;
}

/**
 * Default: Windows → full update; Linux/macOS → detect-only (VPS safety).
 * Override with config.updatePolicy: 'full' | 'detect-only'.
 */
export function resolveUpdateCapabilities(
  platform: NodeJS.Platform,
  policy: UpdatePolicy = 'platform',
): UpdateCapabilities {
  if (policy === 'detect-only') {
    return {
      canDetect: true,
      canInstall: false,
      canRestart: false,
      detectOnlyReason: '当前配置为仅检测模式，不执行安装或重启。',
    };
  }
  if (policy === 'full') {
    return {
      canDetect: true,
      canInstall: true,
      canRestart: true,
      detectOnlyReason: '',
    };
  }
  // platform default
  if (platform === 'win32') {
    return {
      canDetect: true,
      canInstall: true,
      canRestart: true,
      detectOnlyReason: '',
    };
  }
  return {
    canDetect: true,
    canInstall: false,
    canRestart: false,
    detectOnlyReason: 'Linux 服务器仅显示版本检测结果；请在 Windows 本机或 SSH 手动升级。',
  };
}
