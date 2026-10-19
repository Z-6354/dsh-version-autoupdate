import { createHash } from 'node:crypto';
import { clearGithubArtifactVersion, commitGithubArtifact, loadCompleteGithubArtifact, partialByteLength, preparePartialForTransport, readPartialFile, writePartialChunk, } from './artifact-cache.js';
import { normalizeGitHubTag } from './source-detection.js';
import { semverParts, versionCompare } from './semver.js';
export class MirrorClientError extends Error {
    kind;
    retryable;
    constructor(message, kind, retryable, options) {
        super(message, options);
        this.name = 'MirrorClientError';
        this.kind = kind;
        this.retryable = retryable;
    }
}
const DEFAULT_MIRROR = 'https://vps.wannian.fun/dsh-mirror';
const DEFAULT_NPM = '@deepseek-ai/dsh';
const DEFAULT_REPO = 'deepseek-ai/deepseek-harness';
const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
function cleanError(value) {
    const text = value instanceof Error ? value.message : String(value);
    return text
        .replace(/(authorization\s*:\s*bearer\s+)[^\s&'"}]+/gi, '$1[redacted]')
        .replace(/(password\s*[=:]\s*)[^\s&'"}]+/gi, '$1[redacted]')
        .replace(/(x-mirror-password\s*[:=]\s*)[^\s&'"}]+/gi, '$1[redacted]');
}
function sourceRepository(source, options) {
    return source === 'npm' ? (options.npmPackage ?? DEFAULT_NPM) : (options.githubRepository ?? DEFAULT_REPO);
}
function validVersion(value) {
    const parts = semverParts(value);
    return parts !== null && parts.nums.length === 3 && parts.nums.every((n) => Number.isInteger(n) && n >= 0);
}
function targetTag(version, tag) {
    if (!tag)
        return undefined;
    const normalized = normalizeGitHubTag(tag);
    if (!normalized || normalized !== version) {
        throw new MirrorClientError('GitHub tag does not match target version', 'source', false);
    }
    return tag;
}
function assertSourceRepository(source, request) {
    if (request?.repository === undefined)
        return;
    const expected = source === 'github' ? DEFAULT_REPO : DEFAULT_NPM;
    if (request.repository !== expected) {
        throw new MirrorClientError(`source mismatch: ${source} cannot access the requested repository`, 'source', false);
    }
}
function isRetryable(error) {
    return error instanceof MirrorClientError && error.retryable;
}
function parseJson(text, status) {
    try {
        return JSON.parse(text);
    }
    catch {
        throw new MirrorClientError(`invalid response from source (HTTP ${status})`, 'response', true);
    }
}
export class MirrorClient {
    fetchImpl;
    options;
    constructor(options = {}) {
        if (options.npmPackage !== undefined && options.npmPackage !== DEFAULT_NPM)
            throw new MirrorClientError('custom npm package is not supported', 'source', false);
        if (options.githubRepository !== undefined && options.githubRepository !== DEFAULT_REPO)
            throw new MirrorClientError('custom GitHub repository is not supported', 'source', false);
        if (options.mirrorBase !== undefined && options.mirrorBase !== DEFAULT_MIRROR)
            throw new MirrorClientError('custom mirror URL is not supported', 'source', false);
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        this.options = options;
    }
    async getLatest(source, transport, request) {
        assertSourceRepository(source, request);
        if (transport === 'official')
            return this.getOfficialLatest(source);
        try {
            if (!this.options.password)
                throw new MirrorClientError('mirror password unavailable', 'auth', true);
            return await this.getMirrorLatest(source);
        }
        catch (error) {
            if (transport === 'mirror' || !isRetryable(error))
                throw new MirrorClientError(cleanError(error), error instanceof MirrorClientError ? error.kind : 'response', false, { cause: error });
            return this.getOfficialLatest(source);
        }
    }
    async download(source, version, transport, request = {}) {
        assertSourceRepository(source, request);
        if (!version || !validVersion(version))
            throw new MirrorClientError('invalid version', 'source', false);
        const checkedTag = source === 'github' ? targetTag(version, request.tag) : undefined;
        if (transport === 'official') {
            return this.downloadOfficial(source, version, request.expectedSha256, checkedTag, request.onProgress, request.artifactCacheHome);
        }
        try {
            if (!this.options.password)
                throw new MirrorClientError('mirror password unavailable', 'auth', true);
            return await this.downloadMirror(source, version, request.expectedSha256, checkedTag, request.onProgress, request.artifactCacheHome);
        }
        catch (error) {
            if (transport === 'mirror' || !isRetryable(error))
                throw new MirrorClientError(cleanError(error), error instanceof MirrorClientError ? error.kind : 'response', false, { cause: error });
            return this.downloadOfficial(source, version, request.expectedSha256, checkedTag, request.onProgress, request.artifactCacheHome);
        }
    }
    async request(url, mirror, extraHeaders = {}, opts = {}) {
        const headers = { Accept: 'application/json', ...extraHeaders };
        if (mirror && this.options.password)
            headers.Authorization = `Bearer ${this.options.password}`;
        let response;
        try {
            response = await this.fetchImpl(url, { headers });
        }
        catch (error) {
            throw new MirrorClientError(cleanError(error), 'network', true, { cause: error });
        }
        const accepted = opts.acceptStatuses ?? [];
        if (!response.ok && !accepted.includes(response.status)) {
            const kind = response.status === 401 || response.status === 403 ? 'auth' : response.status >= 500 || response.status === 429 ? 'network' : 'response';
            // Only network/rate-limit is auto-retryable → official. Auth must not silent-fallback
            // (password was sent but rejected; resolve channel should re-ask instead).
            throw new MirrorClientError(`source request failed (HTTP ${response.status})`, kind, kind === 'network');
        }
        return response;
    }
    async getMirrorLatest(source) {
        const query = source === 'npm' ? `source=npm&package=${encodeURIComponent(this.options.npmPackage ?? DEFAULT_NPM)}` : `source=github&repo=${encodeURIComponent(this.options.githubRepository ?? DEFAULT_REPO)}`;
        const response = await this.request(`${this.options.mirrorBase ?? DEFAULT_MIRROR}/version?${query}`, true);
        const data = parseJson(await response.text(), response.status);
        const version = source === 'github' ? normalizeGitHubTag(data.tag ?? data.version ?? '') : data.version;
        if (!version)
            throw new MirrorClientError('source response has no valid version', 'response', true);
        return { source, version, tag: source === 'github' ? data.tag : undefined, transport: 'mirror', cached: data.cached };
    }
    async getOfficialLatest(source) {
        if (source === 'npm') {
            const response = await this.request(`https://registry.npmjs.org/${this.options.npmPackage ?? DEFAULT_NPM}`, false);
            const data = parseJson(await response.text(), response.status);
            const versions = Object.keys(data.versions ?? {}).filter(validVersion);
            const version = versions.reduce((best, candidate) => {
                if (best === null || versionCompare(candidate, best) > 0)
                    return candidate;
                return best;
            }, null);
            if (!version)
                throw new MirrorClientError('official npm response has no valid version', 'response', true);
            return { source, version, transport: 'official' };
        }
        const response = await this.request(`https://api.github.com/repos/${this.options.githubRepository ?? DEFAULT_REPO}/tags?per_page=100&page=1`, false);
        const data = parseJson(await response.text(), response.status);
        const candidates = data.map((item) => ({ tag: item.name ?? '', version: normalizeGitHubTag(item.name ?? '') })).filter((item) => item.version !== null);
        const latest = candidates.reduce((best, candidate) => {
            if (best === null || versionCompare(candidate.version, best.version) > 0)
                return candidate;
            return best;
        }, null);
        if (!latest)
            throw new MirrorClientError('official GitHub response has no valid tag', 'response', true);
        return { source, version: latest.version, tag: latest.tag, transport: 'official' };
    }
    async downloadMirror(source, version, expectedSha256, tag, onProgress, artifactCacheHome) {
        const repo = sourceRepository(source, this.options);
        const query = source === 'npm' ? `source=npm&package=${encodeURIComponent(repo)}&version=${encodeURIComponent(version)}&raw=1` : `source=github&repo=${encodeURIComponent(repo)}&version=${encodeURIComponent(tag ?? `dsh-v${version}`)}&format=tarball&raw=1`;
        return this.downloadResponse(`${this.options.mirrorBase ?? DEFAULT_MIRROR}/pull?${query}`, source, version, 'mirror', expectedSha256, tag, onProgress, artifactCacheHome);
    }
    async downloadOfficial(source, version, expectedSha256, tag, onProgress, artifactCacheHome) {
        const repo = sourceRepository(source, this.options);
        const url = source === 'npm' ? `https://registry.npmjs.org/${repo}/-/${repo.split('/').at(-1)}-${version}.tgz` : `https://codeload.github.com/${repo}/tar.gz/refs/tags/${encodeURIComponent(tag ?? `dsh-v${version}`)}`;
        return this.downloadResponse(url, source, version, 'official', expectedSha256, tag, onProgress, artifactCacheHome);
    }
    async downloadResponse(url, source, version, transport, expectedSha256, tag, onProgress, artifactCacheHome) {
        if (artifactCacheHome && source === 'github') {
            const hit = await loadCompleteGithubArtifact(artifactCacheHome, version, tag);
            if (hit) {
                if (expectedSha256 && expectedSha256.toLowerCase() !== hit.sha256.toLowerCase()) {
                    await clearGithubArtifactVersion(artifactCacheHome, version);
                    throw new MirrorClientError(`sha-256 mismatch: expected ${expectedSha256.slice(0, 12)}… got ${hit.sha256.slice(0, 12)}…`, 'integrity', false);
                }
                await onProgress?.({ bytesDownloaded: hit.data.byteLength, bytesTotal: hit.data.byteLength });
                return {
                    source,
                    version: hit.version,
                    transport: hit.transport,
                    data: hit.data,
                    sha256: hit.sha256,
                    tag: hit.tag,
                    fromCache: true,
                };
            }
            return this.downloadResponseCached(url, source, version, transport, expectedSha256, tag ?? `dsh-v${version}`, artifactCacheHome, onProgress);
        }
        const response = await this.request(url, transport === 'mirror');
        const maxBytes = this.options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
        const contentLength = response.headers.get('content-length');
        let bytesTotal = null;
        if (contentLength) {
            const size = Number.parseInt(contentLength, 10);
            if (Number.isFinite(size) && size > maxBytes) {
                throw new MirrorClientError(`download exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB limit`, 'archive', false);
            }
            if (Number.isFinite(size) && size > 0)
                bytesTotal = size;
        }
        const emit = async (bytesDownloaded) => {
            if (onProgress)
                await onProgress({ bytesDownloaded, bytesTotal });
        };
        await emit(0);
        const reader = response.body?.getReader();
        let data;
        if (!reader) {
            data = new Uint8Array(await response.arrayBuffer());
            await emit(data.byteLength);
        }
        else {
            const chunks = [];
            let total = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (value) {
                    total += value.byteLength;
                    if (total > maxBytes)
                        throw new MirrorClientError(`download exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB limit`, 'archive', false);
                    chunks.push(value);
                    await emit(total);
                }
            }
            data = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                data.set(chunk, offset);
                offset += chunk.byteLength;
            }
        }
        if (data.byteLength > maxBytes)
            throw new MirrorClientError(`download exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB limit`, 'archive', false);
        // Tiny payloads are almost always HTML/error pages misread as archives (or text-proxy corruption).
        const minBytes = this.options.minDownloadBytes ?? 1024;
        if (minBytes > 0 && data.byteLength < minBytes) {
            throw new MirrorClientError(`downloaded archive is too small (${data.byteLength} bytes)`, 'archive', false);
        }
        const sha256 = createHash('sha256').update(data).digest('hex');
        if (expectedSha256 && expectedSha256.toLowerCase() !== sha256)
            throw new MirrorClientError(`sha-256 mismatch: expected ${expectedSha256.slice(0, 12)}… got ${sha256.slice(0, 12)}…`, 'integrity', false);
        return { source, version, transport, data, sha256, tag };
    }
    async downloadResponseCached(url, source, version, transport, expectedSha256, tag, cacheHome, onProgress) {
        const maxBytes = this.options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
        await preparePartialForTransport(cacheHome, version, transport);
        let resumeFrom = await partialByteLength(cacheHome, version);
        if (resumeFrom > maxBytes) {
            await clearGithubArtifactVersion(cacheHome, version);
            await preparePartialForTransport(cacheHome, version, transport);
            resumeFrom = 0;
        }
        const extra = {};
        if (resumeFrom > 0)
            extra.Range = `bytes=${resumeFrom}-`;
        let response = await this.request(url, transport === 'mirror', extra, { acceptStatuses: [416] });
        if (response.status === 416) {
            await clearGithubArtifactVersion(cacheHome, version);
            await preparePartialForTransport(cacheHome, version, transport);
            resumeFrom = 0;
            response = await this.request(url, transport === 'mirror');
        }
        let mode = 'replace';
        if (resumeFrom > 0 && response.status === 206) {
            mode = 'append';
        }
        else if (resumeFrom > 0 && response.status === 200) {
            // Server ignored Range — restart the partial file.
            resumeFrom = 0;
            mode = 'replace';
        }
        else if (!response.ok) {
            throw new MirrorClientError(`source request failed (HTTP ${response.status})`, 'response', true);
        }
        const contentLength = response.headers.get('content-length');
        const contentRange = response.headers.get('content-range');
        let bytesTotal = null;
        if (contentRange) {
            const m = /\/(\d+)\s*$/.exec(contentRange);
            if (m) {
                const total = Number.parseInt(m[1], 10);
                if (Number.isFinite(total) && total > 0)
                    bytesTotal = total;
            }
        }
        else if (contentLength) {
            const size = Number.parseInt(contentLength, 10);
            if (Number.isFinite(size) && size > 0) {
                bytesTotal = mode === 'append' ? resumeFrom + size : size;
            }
        }
        if (bytesTotal != null && bytesTotal > maxBytes) {
            throw new MirrorClientError(`download exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB limit`, 'archive', false);
        }
        const emit = async (bytesDownloaded) => {
            if (onProgress)
                await onProgress({ bytesDownloaded, bytesTotal });
        };
        await emit(mode === 'append' ? resumeFrom : 0);
        const reader = response.body?.getReader();
        let written = mode === 'append' ? resumeFrom : 0;
        if (!reader) {
            const chunk = new Uint8Array(await response.arrayBuffer());
            written = await writePartialChunk(cacheHome, version, chunk, mode);
            await emit(written);
        }
        else {
            let first = true;
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (!value || value.byteLength === 0)
                    continue;
                if (first && mode === 'replace') {
                    written = await writePartialChunk(cacheHome, version, value, 'replace');
                }
                else {
                    written = await writePartialChunk(cacheHome, version, value, 'append');
                }
                first = false;
                if (written > maxBytes) {
                    await clearGithubArtifactVersion(cacheHome, version);
                    throw new MirrorClientError(`download exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB limit`, 'archive', false);
                }
                await emit(written);
            }
        }
        const data = await readPartialFile(cacheHome, version);
        const minBytes = this.options.minDownloadBytes ?? 1024;
        if (minBytes > 0 && data.byteLength < minBytes) {
            await clearGithubArtifactVersion(cacheHome, version);
            throw new MirrorClientError(`downloaded archive is too small (${data.byteLength} bytes)`, 'archive', false);
        }
        if (data.byteLength > maxBytes) {
            await clearGithubArtifactVersion(cacheHome, version);
            throw new MirrorClientError(`download exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB limit`, 'archive', false);
        }
        const sha256 = createHash('sha256').update(data).digest('hex');
        if (expectedSha256 && expectedSha256.toLowerCase() !== sha256) {
            await clearGithubArtifactVersion(cacheHome, version);
            throw new MirrorClientError(`sha-256 mismatch: expected ${expectedSha256.slice(0, 12)}… got ${sha256.slice(0, 12)}…`, 'integrity', false);
        }
        try {
            await commitGithubArtifact(cacheHome, {
                version,
                tag,
                transport,
                data,
                sha256,
            });
        }
        catch (error) {
            await clearGithubArtifactVersion(cacheHome, version);
            throw new MirrorClientError(cleanError(error), 'archive', false, { cause: error });
        }
        return { source, version, transport, data, sha256, tag, fromCache: false };
    }
}
function isBinaryArtifactUrl(url) {
    return /codeload\.github\.com/i.test(url)
        || /registry\.npmjs\.org\/.+\/-\//i.test(url)
        || /[?&]raw=1(?:&|$)/i.test(url)
        || /[?&]format=tarball(?:&|$)/i.test(url);
}
/** Mirror JSON (/version) also needs native fetch: Host web.fetch often drops Authorization → 401. */
function isMirrorServiceUrl(url) {
    return url.startsWith(DEFAULT_MIRROR)
        || /\/\/vps\.wannian\.fun\/dsh-mirror\b/i.test(url);
}
/** Prefer Host web for public JSON; native fetch for mirror (auth) and binary archives. */
export function createMirrorClientFromContext(ctx, options = {}) {
    const webSvc = ctx.get('web');
    const fetchImpl = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!webSvc
            || isBinaryArtifactUrl(url)
            || isMirrorServiceUrl(url)
            || typeof globalThis.fetch !== 'function') {
            return globalThis.fetch(input, init);
        }
        try {
            const res = await webSvc.fetch({
                url,
                method: init?.method,
                headers: init?.headers,
            });
            return new Response(res.body.content, { status: res.statusCode });
        }
        catch {
            return globalThis.fetch(input, init);
        }
    };
    return new MirrorClient({ ...options, fetch: fetchImpl });
}
//# sourceMappingURL=mirror-client.js.map