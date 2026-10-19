import { readFile, unlink } from 'node:fs/promises';
import { restartOutcomePath } from './github-staging-paths.js';
/** Finalize a restarting operation once the detached restart helper writes its outcome. */
export async function applyRestartOutcome(store, home) {
    const operation = store.snapshot();
    if (!operation || operation.phase !== 'restarting')
        return null;
    const path = restartOutcomePath(home);
    try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        if (parsed.operationId && parsed.operationId !== operation.id)
            return null;
        const phase = parsed.phase === 'rolled_back' ? 'rolled_back' : parsed.ok ? 'succeeded' : 'failed';
        await store.finish(phase, parsed.error ?? null);
        try {
            await unlink(path);
        }
        catch { /* ignore */ }
        return parsed;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=restart-outcome.js.map