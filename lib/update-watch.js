import { isOperationOrphaned, summarizeOperation, } from './update-operation.js';
import { applyRestartOutcome } from './restart-outcome.js';
/** Report at 1m, 5m, then every 10m from start (10m, 20m, …). */
export const PROGRESS_MILESTONE_MS = [
    60_000,
    5 * 60_000,
];
export const PROGRESS_EVERY_MS = 10 * 60_000;
export function milestoneSchedule(upToMs) {
    const out = [...PROGRESS_MILESTONE_MS];
    for (let t = PROGRESS_EVERY_MS; t <= upToMs; t += PROGRESS_EVERY_MS) {
        if (!out.includes(t))
            out.push(t);
    }
    // Always include the next every-10m slot after upToMs so callers can wait for it.
    const nextEvery = Math.max(PROGRESS_EVERY_MS, Math.ceil((upToMs + 1) / PROGRESS_EVERY_MS) * PROGRESS_EVERY_MS);
    if (!out.includes(nextEvery))
        out.push(nextEvery);
    return out.sort((a, b) => a - b);
}
export function nextMilestoneMs(elapsedMs, lastReportedMilestoneMs) {
    const schedule = milestoneSchedule(Math.max(elapsedMs, lastReportedMilestoneMs) + PROGRESS_EVERY_MS * 2);
    for (const ms of schedule) {
        if (ms > lastReportedMilestoneMs)
            return ms;
    }
    return lastReportedMilestoneMs + PROGRESS_EVERY_MS;
}
export function progressFingerprint(operation) {
    if (!operation)
        return 'none';
    const p = operation.progress;
    return [
        operation.phase,
        operation.error ?? '',
        p?.message ?? '',
        p?.percent ?? '',
        p?.bytesDownloaded ?? '',
        operation.updatedAt,
    ].join('|');
}
function sleepDefault(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            return;
        }
        const timer = setTimeout(resolve, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
async function snapshot(store, dshHome, lastMilestoneMs, reason, reportToUser, milestoneMs, now) {
    await store.load();
    await applyRestartOutcome(store, dshHome);
    const operation = store.snapshot();
    const running = store.isRunning();
    const orphaned = isOperationOrphaned(operation, running, { nowMs: now });
    const startedAt = operation?.startedAt ? Date.parse(operation.startedAt) : NaN;
    const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0;
    const done = orphaned
        || !operation
        || operation.phase === 'succeeded'
        || operation.phase === 'failed'
        || operation.phase === 'rolled_back'
        || Boolean(operation.finishedAt);
    return {
        ok: true,
        running,
        orphaned,
        done,
        summary: summarizeOperation(operation, running),
        elapsedMs,
        milestoneMs,
        reason,
        reportToUser,
        nextLastMilestoneMs: milestoneMs != null ? milestoneMs : lastMilestoneMs,
        operation,
    };
}
/** Block until the next chat-worthy progress event (milestone / terminal / timeout). */
export async function watchUpdateProgress(options) {
    const store = options.store;
    const nowFn = options.now ?? Date.now;
    const sleep = options.sleep ?? sleepDefault;
    const pollMs = options.pollMs ?? 2_000;
    const timeoutMs = options.timeoutMs ?? 11 * 60_000;
    const rawLast = options.lastMilestoneMs;
    const isFirstWatch = rawLast === undefined || rawLast === null;
    let lastMilestoneMs = isFirstWatch ? -1 : Math.max(0, Number(rawLast));
    const deadline = nowFn() + timeoutMs;
    await store.load();
    await applyRestartOutcome(store, options.dshHome);
    let operation = store.snapshot();
    if (!operation) {
        return snapshot(store, options.dshHome, Math.max(0, lastMilestoneMs), 'idle', false, null, nowFn());
    }
    const running = store.isRunning();
    const orphaned = isOperationOrphaned(operation, running);
    if (orphaned) {
        return snapshot(store, options.dshHome, Math.max(0, lastMilestoneMs), 'orphaned', true, null, nowFn());
    }
    if (operation.finishedAt || operation.phase === 'succeeded' || operation.phase === 'failed' || operation.phase === 'rolled_back') {
        return snapshot(store, options.dshHome, Math.max(0, lastMilestoneMs), 'terminal', true, null, nowFn());
    }
    // First watch only: immediate kickoff report so the agent can confirm start without waiting 1 minute.
    const startedAt = Date.parse(operation.startedAt);
    const elapsed0 = Math.max(0, nowFn() - startedAt);
    if (isFirstWatch && elapsed0 < 5_000) {
        return snapshot(store, options.dshHome, 0, 'started', true, 0, nowFn());
    }
    if (lastMilestoneMs < 0)
        lastMilestoneMs = 0;
    const due0 = nextMilestoneMs(elapsed0, lastMilestoneMs);
    if (elapsed0 >= due0 && due0 > lastMilestoneMs) {
        return snapshot(store, options.dshHome, lastMilestoneMs, 'milestone', true, due0, nowFn());
    }
    while (nowFn() < deadline) {
        if (options.signal?.aborted) {
            return snapshot(store, options.dshHome, lastMilestoneMs, 'timeout', true, null, nowFn());
        }
        const wait = Math.min(pollMs, Math.max(0, deadline - nowFn()));
        if (wait > 0)
            await sleep(wait, options.signal);
        await store.load();
        await applyRestartOutcome(store, options.dshHome);
        operation = store.snapshot();
        const now = nowFn();
        if (!operation) {
            return snapshot(store, options.dshHome, lastMilestoneMs, 'idle', false, null, now);
        }
        const stillRunning = store.isRunning();
        const becameOrphan = isOperationOrphaned(operation, stillRunning, { nowMs: now });
        if (becameOrphan) {
            return snapshot(store, options.dshHome, lastMilestoneMs, 'orphaned', true, null, now);
        }
        if (operation.finishedAt || operation.phase === 'succeeded' || operation.phase === 'failed' || operation.phase === 'rolled_back') {
            return snapshot(store, options.dshHome, lastMilestoneMs, 'terminal', true, null, now);
        }
        const elapsed = Math.max(0, now - Date.parse(operation.startedAt));
        const due = nextMilestoneMs(elapsed, lastMilestoneMs);
        if (elapsed >= due && due > lastMilestoneMs) {
            return snapshot(store, options.dshHome, lastMilestoneMs, 'milestone', true, due, now);
        }
    }
    return snapshot(store, options.dshHome, lastMilestoneMs, 'timeout', true, null, nowFn());
}
//# sourceMappingURL=update-watch.js.map