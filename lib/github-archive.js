import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { MirrorClientError } from './mirror-client.js';
import { normalizeGitHubTag } from './source-detection.js';
import { MAX_GITHUB_DOWNLOAD_BYTES } from './github-staging-paths.js';
export { MAX_GITHUB_DOWNLOAD_BYTES };
const HARNESS_MARKERS = ['apps/cli/src/bin.ts', 'apps/cli/lib/bin.js'];
const HARNESS_PACKAGE_NAMES = new Set(['deepseek-harness', '@deepseek-ai/dsh-root']);
/** Reject downloads larger than the configured cap. */
export function assertDownloadSize(size, maxBytes = MAX_GITHUB_DOWNLOAD_BYTES) {
    if (size > maxBytes) {
        throw new MirrorClientError(`download exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB limit`, 'archive', false);
    }
}
/** GitHub archives must unpack to exactly one top-level directory. */
export async function resolveExtractedRoot(extractDir) {
    const entries = await readdir(extractDir, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    if (dirs.length !== 1) {
        throw new MirrorClientError('archive must contain exactly one top-level directory', 'archive', false);
    }
    return join(extractDir, dirs[0].name);
}
/** Validate Harness checkout layout, version, and optional tag. */
export async function validateHarnessCheckout(root, expectedVersion, expectedTag) {
    if (expectedTag) {
        const normalized = normalizeGitHubTag(expectedTag);
        if (!normalized || normalized !== expectedVersion) {
            throw new MirrorClientError('GitHub tag does not match target version', 'source', false);
        }
    }
    const pkgPath = join(root, 'package.json');
    let pkgText;
    try {
        pkgText = await readFile(pkgPath, 'utf8');
    }
    catch {
        throw new MirrorClientError('archive root is missing package.json', 'archive', false);
    }
    let pkg;
    try {
        pkg = JSON.parse(pkgText);
    }
    catch {
        throw new MirrorClientError('archive package.json is invalid JSON', 'archive', false);
    }
    if (!pkg.name || !HARNESS_PACKAGE_NAMES.has(pkg.name)) {
        throw new MirrorClientError('archive package name is not a Harness checkout', 'source', false);
    }
    if (pkg.version !== expectedVersion) {
        throw new MirrorClientError(`archive version ${pkg.version ?? '?'} does not match target ${expectedVersion}`, 'source', false);
    }
    const hasMarker = await Promise.all(HARNESS_MARKERS.map(async (marker) => {
        try {
            await readFile(join(root, marker), 'utf8');
            return true;
        }
        catch {
            return false;
        }
    }));
    if (!hasMarker.some(Boolean)) {
        throw new MirrorClientError('archive is missing Harness CLI markers', 'archive', false);
    }
}
export async function extractTarGzDefault(data, destDir) {
    assertDownloadSize(data.byteLength);
    await mkdir(destDir, { recursive: true });
    const archivePath = join(destDir, 'archive.tar.gz');
    await writeFile(archivePath, data);
    await new Promise((resolve, reject) => {
        const child = spawn('tar', ['-xzf', archivePath, '-C', destDir], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', (error) => reject(new MirrorClientError(`tar extract failed: ${error.message}`, 'archive', false, { cause: error })));
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            // Windows bsdtar cannot create many GitHub-archive symlinks (CLAUDE.md, .claude, …).
            // If only those fail, keep going and let validateHarnessCheckout decide success.
            if (process.platform === 'win32' && isBenignWindowsTarNoise(stderr)) {
                resolve();
                return;
            }
            reject(new MirrorClientError(`tar extract failed (${code}): ${stderr.trim()}`, 'archive', false));
        });
    });
}
/** True when stderr only reports Windows symlink / invalid-argument create failures. */
export function isBenignWindowsTarNoise(stderr) {
    const lines = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0)
        return false;
    const benign = (line) => (/(?:^tar:\s*)?Can't create .*: Invalid argument/i.test(line)
        || /(?:^tar:\s*)?Cannot create symlink/i.test(line)
        || /(?:^tar:\s*)?Cannot create .*symlink/i.test(line)
        || /(?:^tar:\s*)?symlink.*not supported/i.test(line)
        || /(?:^tar:\s*)?Error exit delayed from previous errors/i.test(line));
    if (!lines.some(benign))
        return false;
    return lines.every(benign);
}
export async function extractAndValidateGithubArchive(data, extractDir, expectedVersion, expectedTag, extract = extractTarGzDefault) {
    assertDownloadSize(data.byteLength);
    await mkdir(extractDir, { recursive: true });
    await extract(data, extractDir);
    const root = await resolveExtractedRoot(extractDir);
    await validateHarnessCheckout(root, expectedVersion, expectedTag);
    return root;
}
//# sourceMappingURL=github-archive.js.map