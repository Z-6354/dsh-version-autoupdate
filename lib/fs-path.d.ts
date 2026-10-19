/** Path variants for cross-platform fs lookups (POSIX roots on Windows tests included). */
export declare function pathVariants(path: string): string[];
type FsReader = {
    resolve(path: string): Promise<unknown>;
    readText(target: unknown): Promise<string>;
};
/** Read text from the first resolvable path variant. */
export declare function readTextAt(fs: FsReader, path: string): Promise<string | null>;
export {};
//# sourceMappingURL=fs-path.d.ts.map