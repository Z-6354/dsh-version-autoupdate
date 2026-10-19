import { chmod, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeJsonFileAtomic } from './atomic-json-write.js';
const FILE_DIR = 'version-autoupdate';
const FILE_NAME = 'credentials.json';
/** Resolve storage from the integration-provided DSH home, then documented fallbacks. */
export function resolveCredentialHome(explicit, env = process.env, fallback = join(homedir(), '.dsh')) {
    const selected = explicit?.trim() || env.DSH_HOME?.trim() || fallback;
    return resolve(selected);
}
function credentialPath(home) { return join(resolve(home), FILE_DIR, FILE_NAME); }
/** Read the optional mirror password; absent or malformed files behave as unset. */
export async function readMirrorPassword(home) {
    try {
        const parsed = JSON.parse(await readFile(credentialPath(home), 'utf8'));
        return typeof parsed.mirrorPassword === 'string' && parsed.mirrorPassword.length > 0 ? parsed.mirrorPassword : null;
    }
    catch {
        return null;
    }
}
/** Persist only the mirror password using a same-directory replacement and guaranteed cleanup. */
export async function saveMirrorPassword(home, password) {
    if (!password)
        throw new Error('mirror password must not be empty');
    const dir = join(resolve(home), FILE_DIR);
    await mkdir(dir, { recursive: true });
    const target = join(dir, FILE_NAME);
    await writeJsonFileAtomic(target, { mirrorPassword: password });
    if (process.platform !== 'win32') {
        try {
            await chmod(target, 0o600);
        }
        catch { /* best-effort */ }
    }
}
/** Obtain a password only during an explicit operation; status polling must not call this function. */
export async function ensureMirrorPassword(options) {
    const home = resolveCredentialHome(options.dshHome ?? options.home, options.env, options.defaultHome);
    const existing = await readMirrorPassword(home);
    const reason = options.reason ?? 'first-use';
    if (existing && reason === 'first-use')
        return existing;
    const decision = await options.choose(reason);
    if (decision === 'skip' || decision === 'official')
        return null;
    if (decision === 'cancel')
        throw new Error('mirror credential setup cancelled');
    const password = await options.ask();
    if (!password)
        throw new Error('mirror password was empty');
    if (reason === 'authentication-failed') {
        if (!options.verifyPassword)
            throw new Error('verifyPassword is required after authentication failure');
        if (!await options.verifyPassword(password))
            return existing;
    }
    await saveMirrorPassword(home, password);
    return password;
}
//# sourceMappingURL=credentials.js.map