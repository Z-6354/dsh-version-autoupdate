import { cp, readdir, readFile, access, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { normalizeGitHubTag } from './source-detection.js';
async function pathExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
/** Collect package.json main / exports targets that point under lib/. */
function libEntrypointsFromPackageJson(pkg) {
    const candidates = [];
    if (typeof pkg.main === 'string')
        candidates.push(pkg.main);
    const exp = pkg.exports;
    if (typeof exp === 'string') {
        candidates.push(exp);
    }
    else if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
        for (const value of Object.values(exp)) {
            if (typeof value === 'string')
                candidates.push(value);
            else if (value && typeof value === 'object' && typeof value.default === 'string')
                candidates.push(value.default);
        }
    }
    const out = [];
    const seen = new Set();
    for (const raw of candidates) {
        const cleaned = raw.replace(/^\.\//, '').replace(/\\/g, '/');
        if (!(cleaned === 'lib' || cleaned.startsWith('lib/')))
            continue;
        if (seen.has(cleaned))
            continue;
        seen.add(cleaned);
        out.push(cleaned);
    }
    return out;
}
/**
 * Fail if any apps|packages|vendor|native package declares a lib entrypoint that is missing.
 * Prevents host-only staging from promoting a tree that cannot boot web plugins.
 * Skips test fixtures (`@fixture/*` or path under tests/fixtures).
 */
export async function assertHarnessLibEntrypoints(root) {
    const missing = [];
    const bases = ['apps', 'packages', 'vendor', 'native'];
    function shouldSkipPackage(pkgName, absDir) {
        if (typeof pkgName === 'string' && pkgName.startsWith('@fixture/'))
            return true;
        const norm = absDir.replace(/\\/g, '/');
        if (/\/tests\/fixtures(\/|$)/.test(norm))
            return true;
        if (/\/__fixtures__(\/|$)/.test(norm))
            return true;
        return false;
    }
    async function walk(dir, depth) {
        if (depth > 8)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib')
                continue;
            const abs = join(dir, entry.name);
            const pkgPath = join(abs, 'package.json');
            if (await pathExists(pkgPath)) {
                let pkg;
                try {
                    pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
                }
                catch {
                    await walk(abs, depth + 1);
                    continue;
                }
                const name = typeof pkg.name === 'string' ? pkg.name : relative(root, abs);
                if (!shouldSkipPackage(name, abs)) {
                    for (const entryRel of libEntrypointsFromPackageJson(pkg)) {
                        const entryAbs = join(abs, entryRel);
                        if (!(await pathExists(entryAbs))) {
                            missing.push(`${name} → ${entryRel}`);
                        }
                    }
                }
            }
            await walk(abs, depth + 1);
        }
    }
    for (const base of bases) {
        const start = join(root, base);
        if (await pathExists(start))
            await walk(start, 0);
    }
    if (missing.length > 0) {
        const shown = missing.slice(0, 8).join('; ');
        const more = missing.length > 8 ? ` (+${missing.length - 8} more)` : '';
        throw new Error(`missing lib entry after build/promote: ${shown}${more}`);
    }
}
/** Collect `lib` dirs under apps|packages|vendor|native (skip node_modules). */
export async function listHarnessLibDirs(root) {
    const out = [];
    // `native/` holds @deepseek-ai/node-addon-system (gitignored lib/ from tsc via tsconfig.host).
    // Omitting it leaves live without flock.js after `git checkout` + promote copy.
    const bases = ['apps', 'packages', 'vendor', 'native'];
    async function walk(dir, depth) {
        if (depth > 8)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (entry.name === 'node_modules' || entry.name === '.git')
                continue;
            const abs = join(dir, entry.name);
            if (entry.name === 'lib') {
                out.push(abs);
                continue;
            }
            await walk(abs, depth + 1);
        }
    }
    for (const base of bases) {
        const start = join(root, base);
        if (await pathExists(start))
            await walk(start, 0);
    }
    return out;
}
/** Copy built lib trees from staging onto live (after sources already match the tag). */
export async function copyHarnessBuildArtifacts(stagingRoot, liveRoot) {
    const libs = await listHarnessLibDirs(stagingRoot);
    let copied = 0;
    for (const src of libs) {
        const rel = relative(stagingRoot, src);
        if (!rel || rel.startsWith('..'))
            continue;
        const dest = join(liveRoot, rel);
        await cp(src, dest, { recursive: true, force: true });
        copied += 1;
    }
    // Vite frontend emits apps/web/dist (not named lib/) — required for built-mode boot.
    const webDistRel = join('apps', 'web', 'dist');
    const webDistSrc = join(stagingRoot, webDistRel);
    if (await pathExists(webDistSrc)) {
        await cp(webDistSrc, join(liveRoot, webDistRel), { recursive: true, force: true });
        copied += 1;
    }
    return copied;
}
/**
 * After relink, live must expose every `@deepseek-ai/*` link that staging's web-app has.
 * Skips when staging has no web-app node_modules (unit fixtures).
 */
export async function assertLiveWorkspaceLinked(liveRoot, stagingRoot) {
    const stagingNm = join(stagingRoot, 'packages', 'bundle', 'web-app', 'node_modules', '@deepseek-ai');
    const liveNm = join(liveRoot, 'packages', 'bundle', 'web-app', 'node_modules', '@deepseek-ai');
    if (!(await pathExists(stagingNm)))
        return;
    if (!(await pathExists(liveNm))) {
        throw new Error(`live missing web-app @deepseek-ai links after relink: ${liveNm}`);
    }
    let needed;
    try {
        needed = await readdir(stagingNm);
    }
    catch {
        return;
    }
    const missing = [];
    for (const name of needed) {
        if (!(await pathExists(join(liveNm, name))))
            missing.push(name);
    }
    if (missing.length > 0) {
        const shown = missing.slice(0, 8).join(', ');
        const more = missing.length > 8 ? ` (+${missing.length - 8} more)` : '';
        throw new Error(`live web-app missing workspace links after relink: ${shown}${more}`);
    }
}
/**
 * Restore live to a prior git ref and re-apply snapshotted lib/dist (gitignored).
 * Does NOT relink — caller must relink when node_modules may still match the failed promote.
 */
export async function rollbackLiveToPreviousRef(input) {
    const previousRef = typeof input.previousRef === 'string' ? input.previousRef.trim() : '';
    if (!previousRef)
        throw new Error('rollback requires previousRef');
    if (typeof input.runGit !== 'function')
        throw new Error('rollback requires runGit');
    const rb = await input.runGit(['checkout', '-f', previousRef], input.liveRoot);
    if (rb.exitCode !== 0) {
        throw new Error(
            `git rollback to ${previousRef.slice(0, 12)} failed: ${(rb.stderr || rb.stdout).trim()}`,
        );
    }
    let artifactsRestored = 0;
    const artifactBackupRoot = typeof input.artifactBackupRoot === 'string'
        ? input.artifactBackupRoot.trim()
        : '';
    if (artifactBackupRoot) {
        artifactsRestored = await copyHarnessBuildArtifacts(artifactBackupRoot, input.liveRoot);
    }
    return { previousRef, artifactsRestored };
}
/**
 * Make the live git checkout match the validated staging build:
 * snapshot live lib/dist (gitignored) → checkout tag → copy staging artifacts →
 * relink. On any post-checkout failure: `git checkout -f previousRef` + restore snapshot.
 */
export async function promoteGithubStagingToLive(input) {
    if (typeof input.relinkLive !== 'function') {
        throw new Error('promote requires relinkLive (pnpm install on live after checkout)');
    }
    const tag = input.targetTag
        ?? (`dsh-v${input.targetVersion}`);
    const normalized = normalizeGitHubTag(tag);
    if (!normalized || normalized !== input.targetVersion) {
        throw new Error(`promote tag ${tag} does not match target version ${input.targetVersion}`);
    }
    const head = await input.runGit(['rev-parse', 'HEAD'], input.liveRoot);
    if (head.exitCode !== 0) {
        throw new Error(`git rev-parse failed in live root: ${(head.stderr || head.stdout).trim()}`);
    }
    const previousRef = head.stdout.trim();
    if (!previousRef)
        throw new Error('git rev-parse returned empty HEAD');
    const fetch = await input.runGit(['fetch', '--tags', '--force', 'origin'], input.liveRoot);
    if (fetch.exitCode !== 0) {
        const local = await input.runGit(['rev-parse', '-q', '--verify', `refs/tags/${tag}`], input.liveRoot);
        if (local.exitCode !== 0) {
            throw new Error(`git fetch failed and tag ${tag} is missing locally: ${(fetch.stderr || fetch.stdout).trim()}`);
        }
    }
    // lib/ and apps/web/dist are gitignored — must snapshot before checkout mutates the tree.
    const artifactBackupRoot = typeof input.artifactBackupRoot === 'string'
        ? input.artifactBackupRoot.trim()
        : '';
    let artifactsSnapshotted = 0;
    if (artifactBackupRoot) {
        await mkdir(artifactBackupRoot, { recursive: true });
        artifactsSnapshotted = await copyHarnessBuildArtifacts(input.liveRoot, artifactBackupRoot);
    }
    const checkout = await input.runGit(['checkout', '-f', tag], input.liveRoot);
    if (checkout.exitCode !== 0) {
        throw new Error(`git checkout ${tag} failed: ${(checkout.stderr || checkout.stdout).trim()}`);
    }
    try {
        const binStaging = join(input.stagingRoot, 'apps', 'cli', 'lib', 'bin.js');
        if (!(await pathExists(binStaging))) {
            throw new Error(`staging is missing built bin: ${binStaging}`);
        }
        const webDistStaging = join(input.stagingRoot, 'apps', 'web', 'dist', 'index.html');
        if (!(await pathExists(webDistStaging))) {
            throw new Error(`staging is missing built web dist: ${webDistStaging}`);
        }
        await assertHarnessLibEntrypoints(input.stagingRoot);
        const libsCopied = await copyHarnessBuildArtifacts(input.stagingRoot, input.liveRoot);
        const binLive = join(input.liveRoot, 'apps', 'cli', 'lib', 'bin.js');
        if (!(await pathExists(binLive))) {
            throw new Error(`promote did not produce live bin: ${binLive}`);
        }
        const webDistLive = join(input.liveRoot, 'apps', 'web', 'dist', 'index.html');
        if (!(await pathExists(webDistLive))) {
            throw new Error(`promote did not produce live web dist: ${webDistLive}`);
        }
        await assertHarnessLibEntrypoints(input.liveRoot);
        await input.relinkLive(input.liveRoot);
        await assertLiveWorkspaceLinked(input.liveRoot, input.stagingRoot);
        return {
            previousRef,
            tag,
            libsCopied,
            artifactsSnapshotted,
            rolledBack: false,
            message: `Promoted live checkout to ${tag} (was ${previousRef.slice(0, 12)}…); copied ${libsCopied} lib trees; verified lib entrypoints; relinked and verified workspace links`,
        };
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        let artifactNote = 'lib/dist not restored (no artifactBackupRoot)';
        try {
            const restored = await rollbackLiveToPreviousRef({
                liveRoot: input.liveRoot,
                previousRef,
                artifactBackupRoot,
                runGit: input.runGit,
            });
            artifactNote = artifactBackupRoot
                ? `restored ${restored.artifactsRestored} prior lib/dist trees from snapshot`
                : artifactNote;
        }
        catch (rollbackErr) {
            const rmsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
            throw new Error(
                `promote failed (${msg}); git rollback to ${previousRef.slice(0, 12)} also failed: ${rmsg}`,
            );
        }
        throw new Error(
            `promote failed (${msg}); rolled back git to ${previousRef.slice(0, 12)}; ${artifactNote}`,
        );
    }
}
//# sourceMappingURL=github-promote.js.map