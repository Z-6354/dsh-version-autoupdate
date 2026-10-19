import { join } from 'node:path';
import { readTextAt } from './fs-path.js';
const MARKERS = ['apps/cli/src/bin.ts', 'apps/cli/lib/bin.js', 'apps/cli/src/bin.js'];
/** Collects source evidence from the active DSH root for source detection. */
export async function collectInstallationEvidence(ctx, root) {
    const fs = ctx.get('fs');
    if (!fs || !root)
        return { path: root ?? undefined, hasGit: false, sourceMarkers: [] };
    const read = async (path) => readTextAt(fs, path);
    const packageText = await read(join(root, 'package.json'));
    let metadata;
    try {
        metadata = packageText ? JSON.parse(packageText) : undefined;
    }
    catch {
        metadata = undefined;
    }
    const gitConfig = await read(join(root, '.git', 'config'));
    const sourceMarkers = (await Promise.all(MARKERS.map(async (marker) => (await read(join(root, marker))) ? marker : null))).filter((x) => x !== null);
    return {
        path: root,
        hasGit: gitConfig !== null,
        sourceMarkers,
        remote: gitConfig?.match(/url\s*=\s*([^\r\n]+)/i)?.[1]?.trim(),
        metadata,
    };
}
//# sourceMappingURL=source-evidence.js.map