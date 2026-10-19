const SOURCE_MARKERS = new Set(['apps/cli/src/bin.ts', 'apps/cli/lib/bin.js', 'apps/cli/src/bin.js']);
const TARGET_REPOSITORY = 'deepseek-ai/deepseek-harness';
const GITHUB_REMOTE = /^(?:https?:\/\/|git:\/\/)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?(?:\?.*)?$/i;
const SSH_REMOTE = /^ssh:\/\/(?:git@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?(?:\?.*)?$/i;
const SCP_REMOTE = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?(?:\?.*)?$/i;
const TAG = /^(?:dsh-v|v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;
function repositoryFromRemote(remote) {
    const value = remote.trim();
    const match = GITHUB_REMOTE.exec(value) ?? SSH_REMOTE.exec(value) ?? SCP_REMOTE.exec(value);
    if (!match)
        return null;
    return `${match[1]}/${match[2]}`.toLowerCase();
}
function repositoryFromMetadata(repository) {
    const value = repository.trim().replace(/\.git\/?$/, '').replace(/\/$/, '');
    if (/^github\.com\//i.test(value))
        return value.slice('github.com/'.length).toLowerCase();
    if (/^https?:\/\/github\.com\//i.test(value))
        return value.replace(/^https?:\/\/github\.com\//i, '').toLowerCase();
    return value.toLowerCase();
}
/** Identifies a global npm DSH installation or a proven Harness GitHub checkout. */
export function detectInstallationSource(input) {
    const path = input.path?.replace(/\\/g, '/') ?? '';
    if (/\/node_modules\/((?:@deepseek-ai\/)?dsh(?:-root)?)(?:\/|$)/i.test(path))
        return 'npm';
    const markers = input.sourceMarkers ?? [];
    const hasSource = markers.some((marker) => SOURCE_MARKERS.has(marker.replace(/\\/g, '/')));
    if (!input.hasGit || !hasSource)
        return 'unknown';
    const repository = typeof input.remote === 'string'
        ? repositoryFromRemote(input.remote)
        : typeof input.metadata?.repository === 'string'
            ? repositoryFromMetadata(input.metadata.repository)
            : null;
    if (repository !== TARGET_REPOSITORY)
        return 'unknown';
    return 'github';
}
/** Converts supported DSH GitHub tags to a plain semver-like version. */
export function normalizeGitHubTag(tag) {
    if (typeof tag !== 'string')
        return null;
    const match = TAG.exec(tag.trim());
    if (!match)
        return null;
    return match[1] ?? null;
}
//# sourceMappingURL=source-detection.js.map