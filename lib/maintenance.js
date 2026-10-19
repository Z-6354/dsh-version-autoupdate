import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { writeJsonFileAtomic } from './atomic-json-write.js';
import { maintenancePath as resolveMaintenancePath } from './github-staging-paths.js';

/** @typedef {{ active: boolean, operationId?: string, phase?: string, updatedAt: string, message?: string }} MaintenanceState */

/**
 * Watchdog / helper coordination: while active, do not boot a possibly half-updated live tree.
 */
export async function writeMaintenance(home, state) {
    const path = resolveMaintenancePath(home);
    await mkdir(dirname(path), { recursive: true });
    const body = {
        active: Boolean(state.active),
        operationId: state.operationId ?? null,
        phase: state.phase ?? null,
        message: state.message ?? null,
        updatedAt: new Date().toISOString(),
    };
    await writeJsonFileAtomic(path, body);
    return body;
}

export async function readMaintenance(home) {
    try {
        const parsed = JSON.parse(await readFile(resolveMaintenancePath(home), 'utf8'));
        if (!parsed || typeof parsed !== 'object')
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}

export async function clearMaintenance(home) {
    const path = resolveMaintenancePath(home);
    try {
        await unlink(path);
    }
    catch (error) {
        if (error && error.code !== 'ENOENT')
            throw error;
    }
}

/** True when maintenance hold should block Start-DshWeb. */
export function isMaintenanceHoldActive(state, now = Date.now(), maxAgeMs = 45 * 60 * 1000) {
    if (!state || !state.active)
        return false;
    const stamp = Date.parse(state.updatedAt || '');
    if (!Number.isFinite(stamp))
        return true;
    return (now - stamp) <= maxAgeMs;
}
