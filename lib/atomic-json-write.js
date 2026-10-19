import { rename, unlink, writeFile } from 'node:fs/promises';
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Same-directory atomic JSON write.
 * Windows cannot reliably `rename(tmp → existing)` (EPERM when destination is locked
 * or simply exists); unlink destination first and retry briefly for AV/indexing locks.
 */
export async function writeJsonFileAtomic(target, value) {
    const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    let written = false;
    try {
        await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        written = true;
        await replaceFile(temporary, target);
        written = false;
    }
    finally {
        if (written) {
            try {
                await unlink(temporary);
            }
            catch { /* ignore */ }
        }
    }
}
async function replaceFile(temporary, target) {
    const attempts = process.platform === 'win32' ? 8 : 1;
    let lastError;
    for (let i = 0; i < attempts; i++) {
        try {
            if (process.platform === 'win32') {
                try {
                    await unlink(target);
                }
                catch (error) {
                    const code = error.code;
                    if (code !== 'ENOENT')
                        throw error;
                }
            }
            await rename(temporary, target);
            return;
        }
        catch (error) {
            lastError = error;
            const code = error.code;
            if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
                await sleep(25 * (i + 1));
                continue;
            }
            throw error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
//# sourceMappingURL=atomic-json-write.js.map