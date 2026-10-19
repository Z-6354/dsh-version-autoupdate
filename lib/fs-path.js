/** Path variants for cross-platform fs lookups (POSIX roots on Windows tests included). */
export function pathVariants(path) {
    const normalized = path.replace(/\\/g, '/');
    const win = path.replace(/\//g, '\\');
    return [...new Set([path, normalized, win])];
}
/** Read text from the first resolvable path variant. */
export async function readTextAt(fs, path) {
    for (const attempt of pathVariants(path)) {
        try {
            return await fs.readText(await fs.resolve(attempt));
        }
        catch {
            /* try next variant */
        }
    }
    return null;
}
//# sourceMappingURL=fs-path.js.map