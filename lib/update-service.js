import { versionCompare } from './semver.js';
function compareVersions(a, b) {
    return versionCompare(a, b);
}
/** Provides source-restricted, read-only version checks; credential callbacks are intentionally unused. */
export function createUpdateService(options) {
    return {
        async checkUpdate() {
            const source = options.detectSource ? await options.detectSource() : options.source;
            if (source === 'unknown')
                return { source: 'unknown', transport: 'unknown', currentVersion: options.currentVersion, latestVersion: null, available: false, error: '无法识别安装来源' };
            try {
                const latest = await options.queryLatest(source);
                return { source, transport: latest.transport, currentVersion: options.currentVersion, latestVersion: latest.version, available: options.currentVersion === null || compareVersions(options.currentVersion, latest.version) < 0, error: null };
            }
            catch (error) {
                return { source, transport: 'unknown', currentVersion: options.currentVersion, latestVersion: null, available: false, error: error instanceof Error ? error.message : String(error) };
            }
        },
    };
}
//# sourceMappingURL=update-service.js.map