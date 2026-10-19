/** Precise tsc -b / pnpm Progress parsing; keep CPU/IO light (stdout only). */
const ANSI_RE = /\u001b\[[0-9;]*m/g;
export function stripAnsi(text) {
    return text.replace(ANSI_RE, '');
}
/** Split on CR and LF — pnpm Progress rewrites the same line with \\r. */
export function splitBuildLines(chunk) {
    return stripAnsi(chunk)
        .split(/\r\n|\n|\r/)
        .map((line) => line.trim())
        .filter(Boolean);
}
export function lastUsefulBuildLine(chunk) {
    const lines = splitBuildLines(chunk);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (line.length < 2)
            continue;
        if (/^[\|\/\-\\]+$/.test(line))
            continue;
        return line.length > 160 ? `${line.slice(0, 157)}…` : line;
    }
    return null;
}
export function formatBuildProgressMessage(label, detail) {
    if (!detail)
        return label;
    return `${label} · ${detail}`;
}
/** One-shot JSONC strip for tsconfig.host.json (no full JSONC parser). */
export function stripJsonc(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}
export function countTsconfigReferences(tsconfigJsonText) {
    const data = JSON.parse(stripJsonc(tsconfigJsonText));
    return Array.isArray(data.references) ? data.references.length : 0;
}
/** Map a done/total fraction onto an overall percent band (inclusive). */
export function mapFractionToBand(done, total, bandStart, bandEnd) {
    const t = Math.max(1, total);
    const d = Math.max(0, Math.min(t, done));
    const frac = d / t;
    return Math.round(bandStart + (bandEnd - bandStart) * frac);
}
/** Parse pnpm's `Progress: resolved N, reused N, downloaded N, added N` line. */
export function parsePnpmProgressLine(line) {
    if (!/Progress:\s*resolved/i.test(line))
        return null;
    const resolved = /resolved\s+(\d+)/i.exec(line);
    if (!resolved)
        return null;
    const reused = /reused\s+(\d+)/i.exec(line);
    const downloaded = /downloaded\s+(\d+)/i.exec(line);
    const added = /added\s+(\d+)/i.exec(line);
    return {
        resolved: Number(resolved[1]),
        reused: reused ? Number(reused[1]) : 0,
        downloaded: downloaded ? Number(downloaded[1]) : 0,
        added: added ? Number(added[1]) : 0,
    };
}
/**
 * Exact install fraction from pnpm Progress counts.
 * Linking: added/resolved. Fetch-only: (reused+downloaded)/resolved * 0.85.
 */
export function pnpmProgressFraction(counts) {
    if (counts.resolved <= 0)
        return 0;
    if (counts.added > 0)
        return Math.min(1, counts.added / counts.resolved);
    const fetched = counts.reused + counts.downloaded;
    if (fetched > 0)
        return Math.min(0.85, (fetched / counts.resolved) * 0.85);
    return 0;
}
export function formatPnpmProgressDetail(counts, installPercent) {
    return `added ${counts.added}/${counts.resolved} · ${installPercent}%`;
}
/**
 * Tracks `tsc -b --verbose` project completions.
 * Counts only terminal project events (Building / up to date / Skipping) — not "out of date".
 */
export class TscSolutionProgress {
    done = 0;
    total;
    collectingList = false;
    listed = 0;
    constructor(fallbackTotal) {
        this.total = Math.max(1, fallbackTotal);
    }
    feed(chunk) {
        let changed = false;
        for (const line of splitBuildLines(chunk)) {
            if (/Projects in this build:/i.test(line)) {
                this.collectingList = true;
                this.listed = 0;
                continue;
            }
            if (this.collectingList) {
                if (/^\*\s+\S/.test(line)) {
                    this.listed += 1;
                    this.total = Math.max(1, this.listed);
                    changed = true;
                    continue;
                }
                this.collectingList = false;
            }
            if (/Building project ['"]/i.test(line)
                || /Project ['"][^'"]+['"] is up to date/i.test(line)
                || /Skipping build of project ['"]/i.test(line)) {
                this.done = Math.min(this.total, this.done + 1);
                changed = true;
            }
        }
        const projectPercent = Math.min(100, Math.round((this.done / this.total) * 100));
        return {
            changed,
            done: this.done,
            total: this.total,
            projectPercent,
            message: `tsc ${this.done}/${this.total} projects (${projectPercent}%)`,
        };
    }
    markComplete() {
        this.done = this.total;
        return {
            done: this.done,
            total: this.total,
            projectPercent: 100,
            message: `tsc ${this.done}/${this.total} projects (100%)`,
        };
    }
}
export function bumpBuildPercent(kind, line, current) {
    let next = current;
    if (/Packages:\s*\+/i.test(line))
        next = Math.max(next, 62);
    if (/Done in /i.test(line) || /Already up to date/i.test(line))
        next = Math.max(next, 66);
    return Math.min(68, Math.max(50, next));
}
//# sourceMappingURL=build-progress.js.map