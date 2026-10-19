import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
/** Default cap for GitHub archive downloads (512 MiB). */
export const MAX_GITHUB_DOWNLOAD_BYTES = 512 * 1024 * 1024;
export function resolveAutoupdateHome(explicit, env = process.env) {
    return resolve(explicit?.trim() || env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'version-autoupdate');
}
export function stagingDir(home, operationId) {
    return join(resolveAutoupdateHome(home), 'staging', operationId);
}
export function backupDir(home, operationId) {
    return join(resolveAutoupdateHome(home), 'backup', operationId);
}
export function restartOutcomePath(home) {
    return join(resolveAutoupdateHome(home), 'restart-outcome.json');
}
export function promoteJobPath(home) {
    return join(resolveAutoupdateHome(home), 'promote-job.json');
}
export function maintenancePath(home) {
    return join(resolveAutoupdateHome(home), 'maintenance.json');
}
//# sourceMappingURL=github-staging-paths.js.map