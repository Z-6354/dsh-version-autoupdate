/** Poll an HTTP endpoint until it responds or the deadline expires. */
export declare function waitForHealth(url: string, timeoutMs?: number, intervalMs?: number, fetchImpl?: typeof globalThis.fetch): Promise<boolean>;
//# sourceMappingURL=health-check.d.ts.map