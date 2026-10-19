/** Poll an HTTP endpoint until it responds or the deadline expires. */

/** Auth-gated hosts return 401/403 while up — accept 2xx–4xx like Watchdog. */
export function isHealthStatusAcceptable(status) {
    return Number.isFinite(status) && status >= 200 && status < 500;
}

export async function waitForHealth(url, timeoutMs = 90_000, intervalMs = 1000, fetchImpl = globalThis.fetch) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
        try {
            const response = await fetchImpl(url, { method: 'GET', redirect: 'manual' });
            if (isHealthStatusAcceptable(response.status))
                return true;
        }
        catch {
            /* retry */
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}
