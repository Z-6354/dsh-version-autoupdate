import { findDshRoot } from './dsh-root.js';
import { collectInstallationEvidence } from './source-evidence.js';
import { detectInstallationSource } from './source-detection.js';
import { createMirrorClientFromContext } from './mirror-client.js';
import { createUpdateService } from './update-service.js';
import { readTextAt } from './fs-path.js';
import { join } from 'node:path';
import { isNewer } from './semver.js';
async function readInstalledVersion(ctx) {
    const fsSvc = ctx.get('fs');
    if (!fsSvc)
        return null;
    const root = await findDshRoot(ctx);
    if (!root)
        return null;
    const text = await readTextAt(fsSvc, join(root, 'package.json'));
    if (!text)
        return null;
    try {
        const pkg = JSON.parse(text);
        return typeof pkg.version === 'string' ? pkg.version : null;
    }
    catch {
        return null;
    }
}
/** Source-restricted read-only version check for Host /status and /check. */
export async function runSourceAwareCheck(ctx) {
    const runningVersion = await readInstalledVersion(ctx).catch(() => null);
    const currentVersion = runningVersion;
    const dshRoot = await findDshRoot(ctx);
    const sourceInput = await collectInstallationEvidence(ctx, dshRoot);
    const source = detectInstallationSource(sourceInput);
    const checkedAt = new Date().toISOString();
    if (source === 'unknown') {
        return {
            source: 'unknown',
            transport: 'unknown',
            currentVersion,
            latestVersion: null,
            updateAvailable: false,
            error: [
                '无法识别 DSH 安装来源。',
                'GitHub checkout：目录需含 .git，远程为 deepseek-ai/deepseek-harness，且存在 apps/cli/src/bin.ts 或 apps/cli/lib/bin.js。',
                'npm 全局安装：路径应包含 node_modules/@deepseek-ai/dsh（或 dsh-root）。',
                '请从正确根目录启动 DSH，或重新安装后再试。',
            ].join(' '),
            checkedAt,
            runningVersion,
        };
    }
    const mirror = createMirrorClientFromContext(ctx);
    const service = createUpdateService({
        source,
        currentVersion,
        queryLatest: async (activeSource) => {
            const latest = await mirror.getLatest(activeSource, 'auto');
            return { version: latest.version, transport: latest.transport };
        },
    });
    const result = await service.checkUpdate();
    return {
        source: result.source,
        transport: result.transport,
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        updateAvailable: result.latestVersion !== null && (result.currentVersion === null || isNewer(result.currentVersion, result.latestVersion)),
        error: result.error,
        checkedAt,
        runningVersion,
    };
}
//# sourceMappingURL=source-aware-check.js.map