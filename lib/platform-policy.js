/**
 * Default: Windows → full update; Linux/macOS → detect-only (VPS safety).
 * Override with config.updatePolicy: 'full' | 'detect-only'.
 */
export function resolveUpdateCapabilities(platform, policy = 'platform') {
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
//# sourceMappingURL=platform-policy.js.map