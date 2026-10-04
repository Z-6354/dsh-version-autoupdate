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
  installMethod?: string,
): UpdateCapabilities {
  if (installMethod && installMethod !== 'npm') {
    const base = resolveUpdateCapabilities(platform, policy);
    const reasons: Record<string, string> = {
      desktop: '桌面版请使用 DSH 官方更新流程。',
      npx: '当前为 npx 临时安装，请按原启动方式获取新版本。',
      git: '当前为源码安装，请在源码目录手动更新和构建。',
      unknown: '无法确认当前安装来源，仅提供版本检测。',
    };
    return {
      canDetect: true,
      canInstall: false,
      canRestart: installMethod === 'git' && base.canRestart,
      detectOnlyReason: reasons[installMethod] ?? reasons.unknown!,
    };
  }
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
    detectOnlyReason: `${platform === 'darwin' ? 'macOS' : 'Linux'} 默认仅检测；请按原安装方式升级，或配置 updatePolicy: full。`,
  };
}
