import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAutoupdateHome } from './github-staging-paths.js';
export function githubArtifactPaths(home, version) {
    const dir = join(resolveAutoupdateHome(home), 'cache', 'github', version);
    return {
        dir,
        archive: join(dir, 'archive.tar.gz'),
        partial: join(dir, 'archive.tar.gz.partial'),
        partialMeta: join(dir, 'partial.meta.json'),
        meta: join(dir, 'meta.json'),
    };
}
/**
 * Partial files are transport-specific (mirror vs official URLs differ).
 * Switching channel drops the incomplete file so Range resume cannot mix bytes.
 */
export async function preparePartialForTransport(home, version, transport) {
    const paths = githubArtifactPaths(home, version);
    await mkdir(paths.dir, { recursive: true });
    try {
        const prev = JSON.parse(await readFile(paths.partialMeta, 'utf8'));
        if (prev.transport && prev.transport !== transport) {
            await rm(paths.partial, { force: true });
        }
    }
    catch {
        // no prior partial meta
    }
    await writeFile(paths.partialMeta, `${JSON.stringify({ version, transport }, null, 2)}\n`, 'utf8');
}
export async function clearGithubArtifactVersion(home, version) {
    await rm(githubArtifactPaths(home, version).dir, { recursive: true, force: true });
}
export async function partialByteLength(home, version) {
    try {
        const info = await stat(githubArtifactPaths(home, version).partial);
        return info.isFile() ? info.size : 0;
    }
    catch {
        return 0;
    }
}
/** Return complete cached archive when meta + sha256 verify; otherwise null. */
export async function loadCompleteGithubArtifact(home, version, expectedTag) {
    const paths = githubArtifactPaths(home, version);
    let meta;
    try {
        meta = JSON.parse(await readFile(paths.meta, 'utf8'));
    }
    catch {
        return null;
    }
    if (meta.source !== 'github' || meta.version !== version)
        return null;
    if (expectedTag && meta.tag !== expectedTag)
        return null;
    if (meta.transport !== 'mirror' && meta.transport !== 'official')
        return null;
    if (!meta.sha256 || typeof meta.bytes !== 'number' || meta.bytes <= 0)
        return null;
    let data;
    try {
        data = new Uint8Array(await readFile(paths.archive));
    }
    catch {
        return null;
    }
    if (data.byteLength !== meta.bytes)
        return null;
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (sha256 !== meta.sha256.toLowerCase())
        return null;
    return {
        version: meta.version,
        tag: meta.tag,
        transport: meta.transport,
        data,
        sha256,
    };
}
export async function commitGithubArtifact(home, artifact) {
    const paths = githubArtifactPaths(home, artifact.version);
    await mkdir(paths.dir, { recursive: true });
    const tmp = `${paths.archive}.tmp`;
    await writeFile(tmp, artifact.data);
    const meta = {
        source: 'github',
        version: artifact.version,
        tag: artifact.tag,
        transport: artifact.transport,
        sha256: artifact.sha256,
        bytes: artifact.data.byteLength,
        completedAt: new Date().toISOString(),
    };
    await writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    await rename(tmp, paths.archive);
    await rm(paths.partial, { force: true });
    await rm(paths.partialMeta, { force: true });
}
/** Append or replace partial file; returns total bytes on disk after write. */
export async function writePartialChunk(home, version, chunk, mode) {
    const paths = githubArtifactPaths(home, version);
    await mkdir(paths.dir, { recursive: true });
    if (mode === 'replace') {
        await writeFile(paths.partial, chunk);
        return chunk.byteLength;
    }
    await new Promise((resolve, reject) => {
        const stream = createWriteStream(paths.partial, { flags: 'a' });
        stream.on('error', reject);
        stream.on('finish', () => resolve());
        stream.end(chunk);
    });
    return partialByteLength(home, version);
}
export async function readPartialFile(home, version) {
    return new Uint8Array(await readFile(githubArtifactPaths(home, version).partial));
}
//# sourceMappingURL=artifact-cache.js.map