export async function request(pathname, body) {
    const res = await fetch(pathname, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json());
    if (!res.ok) {
        const msg = typeof data?.message === 'string'
            ? data.message
            : res.statusText;
        throw new Error(msg || `HTTP ${res.status}`);
    }
    return data;
}
//# sourceMappingURL=api.js.map