import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findDshRoot } from './dsh-root.js';
import { createMirrorClientFromContext, MirrorClientError } from './mirror-client.js';
import { extractAndValidateGithubArchive } from './github-archive.js';
import { stagingDir, restartOutcomePath, backupDir, promoteJobPath, resolveAutoupdateHome } from './github-staging-paths.js';
import { readMirrorPassword, resolveCredentialHome } from './credentials.js';
import { formatBytes, formatDownloadProgress, } from './update-operation.js';
import { buildInstallEnv, ensurePnpmReady, formatPnpmArgv, assertHostSpawnableArgv } from './package-manager.js';
import { assertHarnessLibEntrypoints } from './github-promote.js';
import { resolveRestartPlan, retargetGithubPlan, restartHealthUrl, schedulePromoteAndBoot } from './dsh-restart.mjs';
import { writeJsonFileAtomic } from './atomic-json-write.js';
import { writeMaintenance } from './maintenance.js';
import { bumpBuildPercent, countTsconfigReferences, formatBuildProgressMessage, formatPnpmProgressDetail, lastUsefulBuildLine, mapFractionToBand, parsePnpmProgressLine, pnpmProgressFraction, TscSolutionProgress, } from './build-progress.js';
function readCollected(handle) {
    return {
        stdout: handle.collected?.stdout?.readFrom(0).text ?? '',
        stderr: handle.collected?.stderr?.readFrom(0).text ?? '',
    };
}
async function ensurePnpmForGithubBuild(ctx, pnpmPath, onProgress) {
    const sub = ctx.get('subprocess');
    if (!sub)
        throw new Error('subprocess service unavailable');
    if (typeof sub.resolveExecutable !== 'function') {
        throw new Error('subprocess.resolveExecutable unavailable; cannot locate pnpm');
    }
    const subprocess = sub;
    return ensurePnpmReady({
        resolveExecutable: (cmd, resolveEnv) => subprocess.resolveExecutable(cmd, resolveEnv),
        explicitPath: pnpmPath,
        onProgress,
        spawn: async (argv, spawnEnv, cwd) => {
            assertHostSpawnableArgv(argv);
            const handle = subprocess.spawn({
                argv,
                cwd: cwd ?? process.cwd(),
                env: spawnEnv,
                stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
                graceMs: 120_000,
            });
            const outcome = await handle.done;
            const { stdout, stderr } = readCollected(handle);
            return { exitCode: outcome.exitCode, stdout, stderr };
        },
    });
}
async function runSpawnTracked(checkoutRoot, ctx, argv, options) {
    const sub = ctx.get('subprocess');
    if (!sub)
        throw new Error('subprocess service unavailable');
    assertHostSpawnableArgv(argv);
    const handle = sub.spawn({
        argv,
        cwd: checkoutRoot,
        env: options?.env ?? buildInstallEnv(),
        // Bounded in-memory tails + spill; offset reads only process new bytes.
        stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 256 * 1024, spill: { maxBytes: 16 * 1024 * 1024 } },
            stderr: { maxBytes: 1024 * 1024, spill: { maxBytes: 16 * 1024 * 1024 } },
        },
        graceMs: 60_000,
    });
    let offsetOut = 0;
    let offsetErr = 0;
    const poll = async () => {
        const onChunk = options?.onChunk;
        if (!onChunk)
            return;
        try {
            const ro = handle.collected?.stdout?.readFrom(offsetOut);
            if (ro?.text) {
                offsetOut = ro.nextOffset;
                await onChunk(ro.text);
            }
            const re = handle.collected?.stderr?.readFrom(offsetErr);
            if (re?.text) {
                offsetErr = re.nextOffset;
                await onChunk(re.text);
            }
        }
        catch {
            // Ignore transient reader races while the child is still writing.
        }
    };
    // Default 1s: enough for UI, avoids tight-loop CPU on large verbose streams.
    const timer = options?.onChunk
        ? setInterval(() => { void poll(); }, options.pollMs ?? 1_000)
        : null;
    try {
        const outcome = await handle.done;
        await poll();
        if (outcome.exitCode !== 0) {
            const { stderr, stdout } = readCollected(handle);
            const detail = (stderr || stdout).trim().slice(-800);
            throw new Error(`${argv.join(' ')} exited with code ${outcome.exitCode}` +
                (detail ? `\n${detail}` : ''));
        }
    }
    finally {
        if (timer)
            clearInterval(timer);
    }
}
async function runGitCommand(ctx, args, cwd) {
    const sub = ctx.get('subprocess');
    if (!sub?.resolveExecutable)
        throw new Error('subprocess.resolveExecutable unavailable for git');
    const git = await sub.resolveExecutable('git');
    const argv = [git, ...args];
    assertHostSpawnableArgv(argv);
    const handle = sub.spawn({
        argv,
        cwd,
        env: buildInstallEnv(),
        stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 256 * 1024 },
            stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 120_000,
    });
    const outcome = await handle.done;
    const { stdout, stderr } = readCollected(handle);
    return { exitCode: outcome.exitCode, stdout, stderr };
}
async function runPnpmInCheckout(checkoutRoot, ctx, pnpm, args, options) {
    await runSpawnTracked(checkoutRoot, ctx, formatPnpmArgv(pnpm, args), options);
}
/** Run pnpm while mirroring live stdout/stderr into operation progress. */
async function runTrackedPnpmStep(input) {
    let percent = input.basePercent;
    let detail = null;
    const publish = async (force = false) => {
        await input.store.reportProgress({
            message: formatBuildProgressMessage(input.label, detail),
            percent,
        }, force ? { force: true } : undefined);
    };
    await publish(true);
    const heartbeat = setInterval(() => {
        void publish(false);
    }, input.heartbeatMs);
    try {
        await runPnpmInCheckout(input.checkoutRoot, input.ctx, input.pnpm, input.args, {
            // pnpm Progress uses \\r; 500ms is enough to catch updates without tight looping.
            pollMs: 500,
            onChunk: async (chunk) => {
                const line = lastUsefulBuildLine(chunk);
                if (!line)
                    return;
                const prevPercent = percent;
                const counts = parsePnpmProgressLine(line);
                if (counts && counts.resolved > 0) {
                    const frac = pnpmProgressFraction(counts);
                    percent = mapFractionToBand(Math.round(frac * 1000), 1000, 50, 68);
                    detail = formatPnpmProgressDetail(counts, percent);
                }
                else {
                    detail = line;
                    percent = bumpBuildPercent(input.kind, line, percent);
                }
                // Only persist a short progress line (not the whole CR-rewritten buffer).
                input.store.appendTail(`${detail}\n`);
                // Force persist when the bar moves so the capsule is not stuck on a throttled snapshot.
                await publish(percent !== prevPercent);
            },
        });
    }
    finally {
        clearInterval(heartbeat);
    }
}
/**
 * Precise face compile: tsc -b --verbose project fraction, then tsdown for that face.
 * Host alone is not enough for web boot — client packages also declare lib/ entrypoints.
 */
async function runTrackedFaceLibBuild(input) {
    const tscJs = join(input.checkoutRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    let fallbackProjects = 1;
    try {
        const text = await readFile(join(input.checkoutRoot, input.tsconfig), 'utf8');
        fallbackProjects = Math.max(1, countTsconfigReferences(text));
    }
    catch {
        fallbackProjects = 1;
    }
    const tracker = new TscSolutionProgress(fallbackProjects);
    const tscBandStart = input.tscBandStart;
    const tscBandEnd = input.tscBandEnd;
    let message = `${input.face} tsc 0/${tracker.total} projects (0%)`;
    let percent = tscBandStart;
    const publish = async (force = false) => {
        await input.store.reportProgress({ message, percent }, force ? { force: true } : undefined);
    };
    await publish(true);
    const heartbeat = setInterval(() => { void publish(false); }, input.heartbeatMs);
    try {
        await runSpawnTracked(input.checkoutRoot, input.ctx, [
            process.execPath,
            '--max-old-space-size=4096',
            tscJs,
            '-b',
            input.tsconfig,
            '--pretty',
            'false',
            '--verbose',
        ], {
            pollMs: 1_000,
            onChunk: async (chunk) => {
                const snap = tracker.feed(chunk);
                if (!snap.changed)
                    return;
                message = `${input.face} ${snap.message}`;
                percent = mapFractionToBand(snap.done, snap.total, tscBandStart, tscBandEnd);
                input.store.appendTail(`${message}\n`);
                await publish(false);
            },
        });
        const done = tracker.markComplete();
        message = `${input.face} ${done.message}`;
        percent = tscBandEnd;
        input.store.appendTail(`${message}\n`);
        await publish(true);
    }
    finally {
        clearInterval(heartbeat);
    }
    message = `tsdown ${input.face} bundle…`;
    percent = input.tsdownPercent;
    await publish(true);
    const tdBeat = setInterval(() => { void publish(false); }, input.heartbeatMs);
    try {
        await runPnpmInCheckout(input.checkoutRoot, input.ctx, input.pnpm, [
            'exec',
            'tsdown',
            '--env.DSH_BUILD_FACE',
            input.face,
        ], {
            pollMs: 1_000,
            onChunk: async (chunk) => {
                const line = lastUsefulBuildLine(chunk);
                if (!line)
                    return;
                message = `tsdown ${input.face} · ${line}`;
                input.store.appendTail(`${line}\n`);
                await publish(false);
            },
        });
        message = `tsdown ${input.face} bundle done`;
        percent = input.tsdownDonePercent;
        await publish(true);
    }
    finally {
        clearInterval(tdBeat);
    }
}
/** Host + client lib faces, then web dist (copied to live on promote). */
async function runTrackedStagingLibBuild(input) {
    await runTrackedFaceLibBuild({
        ...input,
        face: 'host',
        tsconfig: 'tsconfig.host.json',
        tscBandStart: 55,
        tscBandEnd: 70,
        tsdownPercent: 71,
        tsdownDonePercent: 74,
    });
    await runTrackedFaceLibBuild({
        ...input,
        face: 'client',
        tsconfig: 'tsconfig.client.json',
        tscBandStart: 74,
        tscBandEnd: 88,
        tsdownPercent: 89,
        tsdownDonePercent: 92,
    });
    await withHeartbeat(input.store, 'Staging: build:web…', async () => {
        await runPnpmInCheckout(input.checkoutRoot, input.ctx, input.pnpm, ['run', 'build:web'], {
            pollMs: 1_000,
            onChunk: (chunk) => {
                const line = lastUsefulBuildLine(chunk);
                if (line)
                    input.store.appendTail(`${line}\n`);
            },
        });
    }, input.heartbeatMs, 93);
    input.store.appendTail('build:web finished\n');
    await assertHarnessLibEntrypoints(input.checkoutRoot);
    input.store.appendTail('lib entrypoints verified\n');
}
/** @deprecated use runTrackedStagingLibBuild — kept name as thin alias for older mocks */
async function runTrackedHostLibBuild(input) {
    await runTrackedStagingLibBuild(input);
}
async function withHeartbeat(store, message, work, heartbeatMs, percent) {
    const progress = {
        message,
        ...(typeof percent === 'number' ? { percent } : {}),
    };
    await store.reportProgress(progress, { force: true });
    const timer = setInterval(() => {
        void store.reportProgress({
            ...progress,
            message: `${message} (still working…)`,
        });
    }, heartbeatMs);
    try {
        await work();
    }
    finally {
        clearInterval(timer);
    }
}
function defaultPlans(checkoutRoot) {
    const rollback = resolveRestartPlan();
    const builtBin = join(checkoutRoot, 'apps', 'cli', 'lib', 'bin.js');
    return {
        rollback: {
            exe: rollback.exe,
            args: rollback.args,
            cwd: rollback.cwd,
            port: rollback.port,
            mode: rollback.mode,
        },
        next: retargetGithubPlan(rollback, checkoutRoot),
    };
}
/** Same-source GitHub update: download → validate → build in staging → restart → health rollback. */
export async function runGithubUpdate(host) {
    try {
        await runGithubUpdateInner(host);
    }
    catch (error) {
        if (host.store.isRunning()) {
            await host.store.finish('failed', error instanceof Error ? error.message : String(error));
        }
        throw error;
    }
}
async function runGithubUpdateInner(host) {
    const { ctx, store, targetVersion, transport } = host;
    const operation = store.snapshot();
    if (!operation)
        throw new Error('no active update operation');
    const home = host.dshHome ?? process.env.DSH_HOME;
    const liveRoot = await findDshRoot(ctx);
    if (!liveRoot)
        throw new Error('current Harness checkout root not found');
    const mirrorPassword = host.mirrorPassword !== undefined
        ? host.mirrorPassword
        : await readMirrorPassword(resolveCredentialHome(home));
    const mirror = host.mirror ?? createMirrorClientFromContext(ctx, { password: mirrorPassword });
    const stageRoot = stagingDir(home ?? '', operation.id);
    const extractDir = join(stageRoot, 'extract');
    const heartbeatMs = host.heartbeatMs ?? 5_000;
    // Fail fast before downloading ~tens of MiB if pnpm cannot build staging.
    let readyPnpm = null;
    if (!host.runBuild) {
        await store.patch({
            phase: 'checking',
            liveRoot,
            stagingPath: stageRoot,
            backupPath: liveRoot,
            targetTag: host.targetTag ?? `dsh-v${targetVersion}`,
            progress: { message: 'Checking pnpm for GitHub staging build…' },
        });
        readyPnpm = await ensurePnpmForGithubBuild(ctx, host.pnpmPath, async (message) => {
            store.appendTail(`${message}\n`);
            await store.reportProgress({ message: `pnpm: ${message}` }, { force: true });
        });
        store.appendTail(`pnpm ready: ${formatPnpmArgv(readyPnpm, []).join(' ')} (${readyPnpm.version})\n`);
    }
    await store.patch({
        phase: 'downloading',
        liveRoot,
        stagingPath: stageRoot,
        backupPath: liveRoot,
        targetTag: host.targetTag ?? `dsh-v${targetVersion}`,
        progress: { message: 'Resolving latest GitHub release…' },
    });
    let latestTag = host.targetTag;
    let downloadTransport = transport === 'official' ? 'official' : 'mirror';
    await withHeartbeat(store, 'Resolving latest GitHub release…', async () => {
        let latest;
        if (downloadTransport === 'official') {
            latest = await mirror.getLatest('github', 'official');
        }
        else {
            try {
                latest = await mirror.getLatest('github', 'mirror');
            }
            catch (error) {
                if (!(error instanceof MirrorClientError) || error.kind !== 'network')
                    throw error;
                store.appendTail(`mirror resolve failed (${error.message}); falling back to official\n`);
                await store.reportProgress({ message: 'Mirror unavailable; falling back to official…' }, { force: true });
                latest = await mirror.getLatest('github', 'official');
            }
        }
        // Pin download to the operation targetVersion (from check/force), not whatever
        // getLatest returned — mirror cache and official check can disagree on "latest".
        latestTag = host.targetTag ?? `dsh-v${targetVersion}`;
        downloadTransport = latest.transport;
        if (latest.version !== targetVersion) {
            store.appendTail(`channel ${latest.transport} latest=${latest.version} differs from target=${targetVersion}; pinning target\n`);
        }
        await store.patch({
            transport: latest.transport,
            progress: {
                message: `Resolved channel ${latest.transport}; downloading ${latestTag}`,
            },
        });
    }, heartbeatMs);
    const tag = latestTag ?? `dsh-v${targetVersion}`;
    await store.reportProgress({
        message: `Downloading ${tag} via ${downloadTransport}…`,
        bytesDownloaded: 0,
        bytesTotal: null,
        percent: null,
    }, { force: true });
    let artifact;
    try {
        artifact = await mirror.download('github', targetVersion, downloadTransport, {
            tag,
            artifactCacheHome: home ?? undefined,
            onProgress: async (p) => {
                await store.reportProgress(formatDownloadProgress(p.bytesDownloaded, p.bytesTotal, downloadTransport));
            },
        });
    }
    catch (error) {
        if (downloadTransport !== 'mirror' || !(error instanceof MirrorClientError) || error.kind !== 'network')
            throw error;
        store.appendTail(`mirror download failed (${error.message}); falling back to official\n`);
        await store.reportProgress({ message: 'Mirror download failed; falling back to official…' }, { force: true });
        downloadTransport = 'official';
        artifact = await mirror.download('github', targetVersion, 'official', {
            tag,
            artifactCacheHome: home ?? undefined,
            onProgress: async (p) => {
                await store.reportProgress(formatDownloadProgress(p.bytesDownloaded, p.bytesTotal, 'official'));
            },
        });
    }
    // Persist the channel that actually delivered the archive (mirror vs official).
    downloadTransport = artifact.transport;
    if (artifact.fromCache) {
        store.appendTail(`reused local cache for ${targetVersion} (${artifact.data.byteLength} bytes, sha ${artifact.sha256.slice(0, 12)}…)\n`);
        await store.reportProgress({
            message: `Using local cache for ${targetVersion}`,
            bytesDownloaded: artifact.data.byteLength,
            bytesTotal: artifact.data.byteLength,
            percent: 100,
        }, { force: true });
    }
    else {
        store.appendTail(`downloaded ${artifact.transport} archive (${artifact.data.byteLength} bytes)\n`);
    }
    await store.patch({
        phase: 'installing',
        transport: artifact.transport,
        progress: {
            message: `Extracting ${formatBytes(artifact.data.byteLength)} archive (${artifact.transport})…`,
            bytesDownloaded: artifact.data.byteLength,
            bytesTotal: artifact.data.byteLength,
            percent: 100,
        },
    });
    const checkoutRoot = await extractAndValidateGithubArchive(artifact.data, extractDir, targetVersion, tag, host.extractTarGz);
    store.appendTail(`validated checkout at ${checkoutRoot}\n`);
    if (host.runBuild) {
        await withHeartbeat(store, 'Building staging checkout…', async () => {
            await host.runBuild(checkoutRoot);
        }, heartbeatMs, 70);
    }
    else {
        if (!readyPnpm)
            throw new Error('pnpm was not prepared for staging build');
        await runTrackedPnpmStep({
            store,
            checkoutRoot,
            ctx,
            pnpm: readyPnpm,
            args: ['install', '--ignore-scripts'],
            label: 'Staging: pnpm install…',
            kind: 'install',
            basePercent: 55,
            heartbeatMs,
        });
        store.appendTail('pnpm install finished\n');
        // ignore-scripts skips fs-ext etc.; rebuild so staging/runtime boot does not MODULE_NOT_FOUND.
        await runTrackedPnpmStep({
            store,
            checkoutRoot,
            ctx,
            pnpm: readyPnpm,
            args: ['rebuild'],
            label: 'Staging: pnpm rebuild (native)…',
            kind: 'install',
            basePercent: 68,
            heartbeatMs,
        });
        store.appendTail('pnpm rebuild finished\n');
        await runTrackedHostLibBuild({
            store,
            checkoutRoot,
            ctx,
            pnpm: readyPnpm,
            heartbeatMs,
        });
    }
    store.appendTail('staging build succeeded\n');
    // Mutate live ONLY after host exit — detached promote-and-boot owns promote+boot.
    const livePlans = host.resolvePlans?.(liveRoot) ?? defaultPlans(liveRoot);
    const stagingPlans = defaultPlans(checkoutRoot);
    const versionChanged = Boolean(operation.currentVersion
        && operation.targetVersion
        && operation.currentVersion !== operation.targetVersion);
    const shouldRestart = host.restart === true || (host.restart !== false && versionChanged);
    if (!shouldRestart) {
        // Never mutate live under a running host (half-tree / sidebarRight class bugs).
        // Staging is already built; promote only via promote-and-boot after host exit.
        store.appendTail(
            `skip live promote: restart=false (refuse mutate live under running host); staging=${checkoutRoot}\n`,
        );
        await store.finish('succeeded');
        await store.patch({
            progress: {
                message: `Staging ${targetVersion} ready. Live was NOT mutated (restart=false). Pass restart=true to promote after host exit.`,
            },
            stagingPath: checkoutRoot,
            promotedRoot: null,
        });
        return;
    }
    const autoupdateHome = resolveAutoupdateHome(home ?? '');
    const jobFile = promoteJobPath(home ?? '');
    const port = livePlans.next.port ?? 3080;
    const job = {
        operationId: operation.id,
        dshHome: home ?? '',
        autoupdateHome,
        operationFile: join(autoupdateHome, 'operation.json'),
        outcomeFile: restartOutcomePath(home),
        stateDir: join(autoupdateHome, '..'),
        logFile: join(autoupdateHome, '..', 'version-autoupdate-restart.log'),
        parentPid: process.pid,
        port,
        liveRoot,
        stagingRoot: checkoutRoot,
        targetVersion,
        targetTag: tag,
        artifactBackupRoot: join(backupDir(home ?? '', operation.id), 'live-artifacts'),
        livePlan: livePlans.next,
        stagingPlan: stagingPlans.next,
        nextPlan: livePlans.next,
        rollbackPlan: livePlans.rollback,
        healthUrl: restartHealthUrl(livePlans.next),
        pnpm: readyPnpm
            ? { exe: readyPnpm.exe, prefixArgs: readyPnpm.prefixArgs || [] }
            : null,
    };
    await writeJsonFileAtomic(jobFile, job);
    await writeMaintenance(home ?? '', {
        active: true,
        operationId: operation.id,
        phase: 'promoting',
        message: 'Staging ready; host will exit before live promote',
    });
    await store.patch({
        artifactBackupRoot: job.artifactBackupRoot,
        rollbackPlan: job.rollbackPlan,
        rollbackPnpm: job.pnpm,
        phase: 'promoting',
        progress: {
            message: `Staging ready — exiting host before promoting ${targetVersion}…`,
            percent: 96,
        },
    });
    store.appendTail(`wrote promote job ${jobFile}; scheduling promote-and-boot\n`);
    const restart = schedulePromoteAndBoot({
        jobPath: jobFile,
        delayMs: 2000,
    });
    store.appendTail(`${restart.message}\n`);
    if (!restart.ok) {
        await writeMaintenance(home ?? '', { active: false, phase: 'failed', message: restart.message });
        await store.finish('failed', restart.message ?? 'promote-and-boot scheduling failed');
        return;
    }
}
//# sourceMappingURL=github-update-worker.js.map
/** Schedule same-source rollback; only the detached helper may touch live. */
export async function scheduleGithubRollback(host) {
    const { store, previousOperation: old } = host;
    const home = host.dshHome || '';
    const operation = store.snapshot();
    const liveRoot = old.liveRoot || old.backupPath;
    if (!liveRoot || !old.id) throw new Error('GitHub rollback metadata is missing');
    const restoreLive = !old.promotedRoot || old.promotedRoot === liveRoot;
    if (restoreLive && !old.previousRef) throw new Error('Previous Git ref is missing; refusing to restart the updated live tree');
    const artifactBackupRoot = old.artifactBackupRoot || join(backupDir(home, old.id), 'live-artifacts');
    if (restoreLive) {
        const { access } = await import('node:fs/promises');
        await access(artifactBackupRoot); // Never silently restore only git while leaving new ignored artifacts.
    }
    const originFile = join(backupDir(home, old.id), 'operation.json');
    await writeJsonFileAtomic(originFile, old);
    const plan = old.rollbackPlan || defaultPlans(liveRoot).next;
    const autoupdateHome = resolveAutoupdateHome(home);
    const job = {
        action: 'rollback', operationId: operation.id, previousOperationId: old.id,
        dshHome: home, autoupdateHome, operationFile: join(autoupdateHome, 'operation.json'),
        outcomeFile: restartOutcomePath(home), stateDir: join(autoupdateHome, '..'),
        logFile: join(autoupdateHome, '..', 'version-autoupdate-restart.log'),
        parentPid: process.pid, port: plan.port || 3080, liveRoot,
        previousRef: restoreLive ? old.previousRef : '', artifactBackupRoot,
        rollbackPlan: plan, targetVersion: old.backupVersion, pnpm: old.rollbackPnpm,
        healthUrl: restartHealthUrl(plan),
    };
    const jobPath = promoteJobPath(home);
    await writeJsonFileAtomic(jobPath, job);
    await store.patch({ phase: 'promoting', liveRoot, previousOperationId: old.id,
        previousOperationFile: originFile, previousRef: old.previousRef,
        artifactBackupRoot, progress: { message: 'Waiting for host exit before restoring the previous version…' } });
    await writeMaintenance(home, { active: true, operationId: operation.id, phase: 'promoting', message: 'Rollback waiting for host exit' });
    const result = (host.schedule || schedulePromoteAndBoot)({ jobPath, delayMs: 2000 });
    if (!result.ok) await writeMaintenance(home, { active: false, phase: 'failed', message: result.message });
    return result;
}
