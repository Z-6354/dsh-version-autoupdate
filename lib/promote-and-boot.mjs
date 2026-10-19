/**
 * Detached promote + boot for GitHub updates.
 * Runs AFTER the dsh host process exits so live is never mutated under a running web.
 *
 * Usage: node promote-and-boot.mjs <promote-job.json>
 *
 * Works with or without Watchdog:
 *  - no watchdog → spawn next plan itself
 *  - watchdog → write next-root; watchdog relaunches; helper only health-checks
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { restartHealthUrl } from './dsh-restart.mjs';
import { promoteGithubStagingToLive, rollbackLiveToPreviousRef } from './github-promote.js';
import { writeJsonFileAtomic } from './atomic-json-write.js';
import { formatPnpmArgv, makeSpawnablePnpm, packageManagerExtraBinDirs } from './package-manager.js';
import {
  detectWatchdogHandoff,
  writeWatchdogNextRoot,
  resolveWindowsPowerShellPath,
} from './dsh-restart.mjs';
import { clearMaintenance, writeMaintenance } from './maintenance.js';
import { isHealthStatusAcceptable } from './health-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry)
    return false;
  try {
    return resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(entry).toLowerCase();
  } catch {
    return false;
  }
}

function log(job, line) {
  const p = job.logFile || join(job.stateDir || dirname(job.operationFile), '..', 'version-autoupdate-restart.log');
  try {
    writeFileSync(p, `[${new Date().toISOString()}] promote-and-boot ${line}\n`, { flag: 'a', encoding: 'utf8' });
  } catch { /* ignore */ }
  try {
    console.error(`[promote-and-boot] ${line}`);
  } catch { /* ignore */ }
}

function loadJob(path) {
  const raw = readFileSync(path, 'utf8');
  const job = JSON.parse(raw);
  if (!job || typeof job !== 'object')
    throw new Error('invalid promote job');
  return job;
}

async function waitForPidExit(pid, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return 'exited';
    }
    if (Date.now() - started >= 12_000) {
      try {
        if (process.platform === 'win32') {
          execFileSync(resolveWindowsPowerShellPath(), [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-Command', `Stop-Process -Id ${Number(pid)} -Force -ErrorAction SilentlyContinue`,
          ], { windowsHide: true, timeout: 8000 });
        } else {
          process.kill(pid, 'SIGKILL');
        }
      } catch { /* ignore */ }
      return 'killed';
    }
    await sleep(400);
  }
  throw new Error(`parent pid ${pid} did not exit`);
}

async function waitPortFree(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  const p = Number(port) || 3080;
  while (Date.now() < deadline) {
    const busy = await isPortListening(p);
    if (!busy)
      return;
    await sleep(500);
  }
  // Timed out still busy — proceed; spawn/health will surface the conflict.
}

/** True when something is listening on 127.0.0.1:port. */
export async function isPortListening(port) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0)
    return false;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(resolveWindowsPowerShellPath(), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command',
        `@(Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue).Count`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      const n = Number.parseInt(String(out).trim(), 10);
      if (Number.isFinite(n))
        return n > 0;
      // Ambiguous PS output — fall through to TCP probe
    } catch {
      // PS failed — fall through to TCP probe (do NOT treat as free)
    }
  }
  return await tcpListenProbe(p);
}

function tcpListenProbe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 800 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Best-effort: free the listen port so Watchdog / rollback can bind again. */
export async function killListenersOnPort(port) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0)
    return;
  if (process.platform === 'win32') {
    try {
      execFileSync(resolveWindowsPowerShellPath(), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command',
        `$pids = @(Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); foreach ($x in $pids) { if ($x -gt 0) { Stop-Process -Id $x -Force -ErrorAction SilentlyContinue } }`,
      ], { windowsHide: true, timeout: 15000 });
    } catch { /* ignore */ }
  } else {
    try {
      execFileSync('bash', ['-lc', `fuser -k ${p}/tcp 2>/dev/null || true`], {
        timeout: 8000,
      });
    } catch { /* ignore */ }
  }
  await sleep(800);
}

function spawnCollect(argv, opts = {}) {
  return new Promise((resolve) => {
    const [exe, ...args] = argv;
    const child = spawn(exe, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => { stdout += String(c); if (stdout.length > 512_000) stdout = stdout.slice(-256_000); });
    child.stderr?.on('data', (c) => { stderr += String(c); if (stderr.length > 512_000) stderr = stderr.slice(-256_000); });
    child.on('error', (error) => {
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function runGit(args, cwd) {
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  const result = execFileSync(git, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { exitCode: 0, stdout: String(result || ''), stderr: '' };
}

function resolvePnpmFromJob(job) {
  if (job.pnpm && job.pnpm.exe) {
    return makeSpawnablePnpm({
      exe: job.pnpm.exe,
      prefixArgs: Array.isArray(job.pnpm.prefixArgs) ? job.pnpm.prefixArgs : [],
    });
  }
  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData)
      candidates.push(join(appData, 'npm', 'pnpm.cmd'));
    for (const dir of packageManagerExtraBinDirs()) {
      candidates.push(join(dir, 'pnpm.cmd'), join(dir, 'pnpm.exe'));
    }
  } else {
    for (const dir of packageManagerExtraBinDirs()) {
      candidates.push(join(dir, 'pnpm'));
    }
    candidates.push('pnpm');
  }
  for (const exe of candidates) {
    if (exe === 'pnpm' || existsSync(exe)) {
      return makeSpawnablePnpm({ exe, prefixArgs: [] });
    }
  }
  throw new Error('pnpm not found for promote-and-boot relink');
}

async function relinkLive(job, root) {
  const pnpm = resolvePnpmFromJob(job);
  for (const args of [['install', '--ignore-scripts'], ['rebuild']]) {
    const argv = formatPnpmArgv(pnpm, args);
    log(job, `relink ${argv.join(' ')} cwd=${root}`);
    const result = await spawnCollect(argv, { cwd: root, env: process.env });
    if (result.exitCode !== 0) {
      throw new Error(`pnpm ${args.join(' ')} failed: ${(result.stderr || result.stdout).slice(-800)}`);
    }
  }
}

async function patchOperation(job, patch) {
  if (!job.operationFile || !existsSync(job.operationFile))
    return;
  let op = {};
  try {
    op = JSON.parse(readFileSync(job.operationFile, 'utf8'));
  } catch { /* ignore */ }
  const next = {
    ...op,
    ...patch,
    progress: patch.progress ? { ...(op.progress || {}), ...patch.progress } : op.progress,
    updatedAt: new Date().toISOString(),
  };
  if (patch.tailAppend) {
    next.tail = `${op.tail || ''}${patch.tailAppend}`.slice(-6000);
    delete next.tailAppend;
  }
  await writeJsonFileAtomic(job.operationFile, next);
}

async function writeOutcome(job, phase, ok, rolledBack, errorMsg) {
  if (!job.outcomeFile)
    return;
  await writeJsonFileAtomic(job.outcomeFile, {
    ok,
    phase,
    rolledBack: Boolean(rolledBack),
    operationId: job.operationId || '',
    error: errorMsg || '',
    at: new Date().toISOString(),
  });
}

async function waitHealth(url, timeoutMs = 150_000, dwellMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual' });
      if (isHealthStatusAcceptable(res.status)) {
        const dwellDeadline = Date.now() + dwellMs;
        while (Date.now() < dwellDeadline) {
          await sleep(2000);
          const again = await fetch(url, { method: 'GET', redirect: 'manual' });
          if (!isHealthStatusAcceptable(again.status))
            throw new Error('stability lost');
        }
        return true;
      }
    } catch {
      /* retry */
    }
    await sleep(1000);
  }
  return false;
}

function startPlan(plan) {
  const child = spawn(plan.exe, plan.args || [], {
    cwd: plan.cwd,
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

/**
 * Hand off to Watchdog (or clear hold for self-spawn).
 * MUST write next-root before clearing maintenance — otherwise Watchdog may
 * Start-DshWeb on the default live root while scheme B needed staging.
 * If handoff cannot write next-root, keep the hold so the caller can self-spawn
 * without Watchdog racing onto the wrong root.
 */
export async function releaseBootHold(opts) {
  const home = opts.home;
  const handoff = Boolean(opts.handoff);
  const planCwd = typeof opts.planCwd === 'string' ? opts.planCwd.trim() : '';
  const stateDir = opts.stateDir;
  let nextRootWritten = false;
  if (handoff) {
    if (planCwd) {
      const path = writeWatchdogNextRoot(planCwd, stateDir);
      nextRootWritten = Boolean(path);
    }
    if (!nextRootWritten) {
      return { nextRootWritten: false, holdCleared: false };
    }
  }
  await clearMaintenance(home);
  return { nextRootWritten, holdCleared: true };
}

function makeRunGit() {
  return (args, cwd) => {
    try {
      return runGit(args, cwd);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { exitCode: 1, stdout: '', stderr: msg };
    }
  };
}

/**
 * After live promote boots unhealthy: hold Watchdog, restore previous git+artifacts,
 * relink, then hand off / spawn the rollback plan and verify health.
 */
async function rollbackAfterUnhealthyPromote(job, opts) {
  const {
    home,
    stateDir,
    handoff,
    port,
    healthUrl,
    previousRef,
  } = opts;
  await writeMaintenance(home, {
    active: true,
    operationId: job.operationId,
    phase: 'rolling_back',
    message: 'Health failed; restoring previous live checkout…',
  });
  await (opts.killListeners || killListenersOnPort)(port);
  await patchOperation(job, {
    progress: { message: 'Health failed — rolling back live git checkout…', percent: 99 },
    tailAppend: `promote-and-boot: health failed; git rollback to ${previousRef.slice(0, 12)}…\n`,
  });

  const restored = await (opts.restore || rollbackLiveToPreviousRef)({
    liveRoot: job.liveRoot,
    previousRef,
    artifactBackupRoot: job.artifactBackupRoot,
    runGit: makeRunGit(),
  });
  log(job, `git rollback ok ref=${previousRef.slice(0, 12)} artifacts=${restored.artifactsRestored}`);
  await patchOperation(job, {
    progress: { message: 'Relinking live after rollback…', percent: 99 },
  });
  await (opts.relink || relinkLive)(job, job.liveRoot);

  const rbPlan = job.rollbackPlan;
  const bootCwd = (rbPlan?.cwd || job.liveRoot || '').trim();
  if (handoff) {
    const written = writeWatchdogNextRoot(bootCwd, stateDir);
    if (!written) {
      await clearMaintenance(home);
      if (!rbPlan?.exe)
        throw new Error('rollback next-root write failed and no rollbackPlan to self-spawn');
      const pid = (opts.startPlan || startPlan)(rbPlan);
      log(job, `rollback next-root write failed; self-spawned pid=${pid}`);
    } else {
      await clearMaintenance(home);
      log(job, `health fail → watchdog next-root rollback=${bootCwd}`);
    }
  } else {
    await clearMaintenance(home);
    if (!rbPlan?.exe)
      throw new Error('rollbackPlan missing after git restore');
    const pid = (opts.startPlan || startPlan)(rbPlan);
    log(job, `rollback spawned pid=${pid} cwd=${bootCwd}`);
  }

  const ok = await (opts.waitHealth || waitHealth)(healthUrl, job.rollbackHealthTimeoutMs || 90_000, job.rollbackDwellMs || 5_000);
  if (!ok)
    throw new Error('rollback boot did not become healthy');
  return true;
}

export async function runManualRollback(job, deps = {}) {
  const home = job.dshHome || join(job.autoupdateHome, '..');
  const stateDir = job.stateDir || join(home, '..');
  const handoff = deps.handoff ?? Boolean(detectWatchdogHandoff(stateDir).handoff);
  const plan = job.rollbackPlan;
  if (!plan?.exe) throw new Error('Rollback launch plan is missing');
  if (job.previousRef) {
    await rollbackAfterUnhealthyPromote(job, { home, stateDir, handoff,
      port: plan.port || job.port || 3080, healthUrl: job.healthUrl,
      previousRef: job.previousRef, ...deps });
  } else {
    // Staging fallback left live unchanged; restore only the original launch plan.
    await releaseBootHold({ home, stateDir, handoff, planCwd: plan.cwd });
    if (!handoff) (deps.startPlan || startPlan)(plan);
    if (!await (deps.waitHealth || waitHealth)(job.healthUrl, job.rollbackHealthTimeoutMs || 90_000, job.rollbackDwellMs || 5_000))
      throw new Error('Rollback boot did not become healthy');
  }
  await writeOutcome(job, 'rolled_back', true, true, '');
  await patchOperation(job, { phase: 'rolled_back', currentVersion: job.targetVersion,
    finishedAt: new Date().toISOString(), error: null,
    progress: { message: 'Previous version restored and health checked', percent: 100 } });
}
async function main() {
  const jobPath = process.argv[2];
  if (!jobPath)
    throw new Error('usage: promote-and-boot.mjs <promote-job.json>');
  const job = loadJob(jobPath);
  const dshHome = job.dshHome || join(job.autoupdateHome || dirname(jobPath), '..');
  const home = dshHome;
  log(job, `start operationId=${job.operationId || '-'} live=${job.liveRoot} staging=${job.stagingRoot}`);

  await writeMaintenance(home, {
    active: true,
    operationId: job.operationId,
    phase: 'promoting',
    message: 'Waiting for host exit before promoting live…',
  });
  await patchOperation(job, {
    phase: 'promoting',
    progress: { message: 'Host exiting; promote helper waiting…', percent: 96 },
  });

  if (job.parentPid)
    await waitForPidExit(Number(job.parentPid));
  await waitPortFree(Number(job.port || 3080));
  if (job.action === 'rollback') {
    await runManualRollback(job);
    try { unlinkSync(jobPath); } catch {}
    return;
  }

  await writeMaintenance(home, {
    active: true,
    operationId: job.operationId,
    phase: 'promoting',
    message: 'Promoting staging into live…',
  });
  await patchOperation(job, {
    phase: 'promoting',
    progress: { message: 'Promoting into live checkout…', percent: 97 },
    tailAppend: 'promote-and-boot: parent exited; promoting live\n',
  });

  let launchRoot = job.stagingRoot;
  let promotedToLive = false;
  let previousRef = '';
  try {
    const promo = await promoteGithubStagingToLive({
      liveRoot: job.liveRoot,
      stagingRoot: job.stagingRoot,
      targetVersion: job.targetVersion,
      targetTag: job.targetTag,
      artifactBackupRoot: job.artifactBackupRoot,
      runGit: makeRunGit(),
      relinkLive: async (root) => {
        await patchOperation(job, {
          progress: { message: 'Relinking live workspace deps…', percent: 98 },
        });
        await relinkLive(job, root);
      },
    });
    launchRoot = job.liveRoot;
    promotedToLive = true;
    previousRef = promo.previousRef || '';
    log(job, promo.message || 'promote ok');
    await patchOperation(job, {
      progress: { message: promo.message || 'Promoted to live', percent: 99 },
      tailAppend: `${promo.message || 'promote ok'}\n`,
      promotedRoot: launchRoot,
      previousRef: previousRef || undefined,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(job, `promote failed: ${msg}; scheme B staging`);
    launchRoot = job.stagingRoot;
    promotedToLive = false;
    await patchOperation(job, {
      progress: { message: `Live promote failed; booting staging…`, percent: 98 },
      tailAppend: `promote-and-boot: live promote failed (${msg}); scheme B staging\n`,
      promotedRoot: launchRoot,
    });
  }

  const plan = promotedToLive
    ? (job.livePlan || job.nextPlan)
    : (job.stagingPlan || job.nextPlan);
  if (!plan || !plan.exe || !plan.cwd)
    throw new Error('promote job missing launch plan');

  const stateDir = job.stateDir || join(home, '..');
  const watchdog = detectWatchdogHandoff(stateDir);
  let handoff = Boolean(watchdog.handoff);

  await patchOperation(job, {
    phase: 'restarting',
    progress: {
      message: handoff
        ? `Handoff to Watchdog from ${promotedToLive ? 'live' : 'staging'}…`
        : `Starting DSH from ${promotedToLive ? 'live' : 'staging'}…`,
      percent: 99,
    },
  });

  // Tree is fully linked (or scheme B staging). Write next-root BEFORE clearing
  // maintenance so Watchdog never boots without the override (scheme B safe).
  const release = await releaseBootHold({
    home,
    handoff,
    planCwd: plan.cwd,
    stateDir,
  });
  if (handoff && !release.holdCleared) {
    log(job, `watchdog next-root write failed; falling back to self-spawn cwd=${plan.cwd}`);
    await clearMaintenance(home);
    handoff = false;
    const newPid = startPlan(plan);
    log(job, `spawned pid=${newPid} cwd=${plan.cwd}`);
  } else if (handoff) {
    log(job, `watchdog handoff next-root=${plan.cwd} written=${release.nextRootWritten}`);
  } else {
    const newPid = startPlan(plan);
    log(job, `spawned pid=${newPid} cwd=${plan.cwd}`);
  }

  const healthUrl = restartHealthUrl(plan);
  const ok = await waitHealth(healthUrl, job.healthTimeoutMs || 180_000, job.dwellMs || 25_000);
  if (ok) {
    log(job, 'health stable → succeeded');
    await writeOutcome(job, 'succeeded', true, false, '');
    await patchOperation(job, {
      phase: 'succeeded',
      finishedAt: new Date().toISOString(),
      currentVersion: job.targetVersion || undefined,
      error: null,
      progress: { message: 'Update succeeded', percent: 100 },
      tailAppend: 'promote-and-boot: succeeded\n',
    });
  } else {
    log(job, 'health failed');
    const port = Number(plan.port || job.port || 3080);
    try {
      if (promotedToLive && previousRef) {
        // True rollback: restore previous git + artifacts (not just re-spawn same broken tree).
        await rollbackAfterUnhealthyPromote(job, {
          home,
          stateDir,
          handoff,
          port,
          healthUrl,
          previousRef,
        });
        await writeOutcome(job, 'rolled_back', false, true, 'health check failed');
        await patchOperation(job, {
          phase: 'rolled_back',
          finishedAt: new Date().toISOString(),
          error: 'health check failed after promote; restored previous live checkout',
          progress: { message: 'Update rolled back' },
          tailAppend: `promote-and-boot: health failed; git rolled back to ${previousRef.slice(0, 12)} (handoff=${handoff ? 1 : 0})\n`,
        });
      } else if (job.rollbackPlan?.exe) {
        // Scheme B: live unchanged (or already restored by promote); just boot prior plan.
        if (handoff) {
          writeWatchdogNextRoot(job.rollbackPlan.cwd || job.liveRoot, stateDir);
          log(job, `health fail → watchdog next-root rollback=${job.rollbackPlan.cwd}`);
          await (opts.killListeners || killListenersOnPort)(port);
        } else {
          startPlan(job.rollbackPlan);
        }
        const rbOk = await waitHealth(
          healthUrl,
          job.rollbackHealthTimeoutMs || 90_000,
          job.rollbackDwellMs || 5_000,
        );
        if (!rbOk)
          throw new Error('scheme B rollback boot did not become healthy');
        await writeOutcome(job, 'rolled_back', false, true, 'health check failed');
        await patchOperation(job, {
          phase: 'rolled_back',
          finishedAt: new Date().toISOString(),
          error: 'health check failed after promote',
          progress: { message: 'Update rolled back' },
          tailAppend: `promote-and-boot: health failed; rolled back to prior plan (handoff=${handoff ? 1 : 0})\n`,
        });
      } else {
        await writeOutcome(job, 'failed', false, false, 'health check failed');
        await patchOperation(job, {
          phase: 'failed',
          finishedAt: new Date().toISOString(),
          error: handoff ? 'listen/health timeout (watchdog handoff)' : 'health check failed',
          progress: { message: 'Update failed: health check' },
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      try {
        await clearMaintenance(home);
      } catch { /* ignore */ }
      await writeOutcome(job, 'failed', false, false, msg);
      await patchOperation(job, {
        phase: 'failed',
        finishedAt: new Date().toISOString(),
        error: msg,
        progress: { message: `Update failed: ${msg}` },
        tailAppend: `promote-and-boot: health/rollback failed: ${msg}\n`,
      });
    }
  }

  try {
    unlinkSync(jobPath);
  } catch { /* ignore */ }
}

const isCli = isDirectRun();

if (isCli) {
  main().catch(async (error) => {
    const msg = error instanceof Error ? error.message : String(error);
    try {
      console.error(msg);
    } catch { /* ignore */ }
    try {
      const jobPath = process.argv[2];
      if (jobPath && existsSync(jobPath)) {
        const job = loadJob(jobPath);
        const home = job.dshHome || join(job.autoupdateHome || dirname(jobPath), '..');
        await clearMaintenance(home);
        await writeOutcome(job, 'failed', false, false, msg);
        await patchOperation(job, {
          phase: 'failed',
          finishedAt: new Date().toISOString(),
          error: msg,
          progress: { message: `Update failed: ${msg}` },
          tailAppend: `promote-and-boot FATAL: ${msg}\n`,
        });
      }
    } catch { /* ignore */ }
    process.exit(1);
  });
}