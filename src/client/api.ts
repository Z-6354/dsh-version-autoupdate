export async function request(pathname: string, body?: unknown): Promise<unknown> {
  const res = await fetch(pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as unknown;
  if (!res.ok) {
    const msg = typeof (data as { message?: string })?.message === 'string'
      ? (data as { message: string }).message
      : res.statusText;
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return data;
}
