/**
 * API client. The access token lives only in memory (never localStorage), so it disappears with the
 * tab; the refresh token is an HttpOnly cookie the browser sends only to /api/v1/auth.
 */
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSessionLost: () => void = () => {};

export function setSessionLostHandler(fn: () => void) {
  onSessionLost = fn;
}
export function setAccessToken(t: string | null) {
  accessToken = t;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'carebridge' },
        body: '{}',
      });
      if (!res.ok) return false;
      accessToken = (await res.json()).accessToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}, retry = true): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      ...(opts.body !== undefined && { 'Content-Type': 'application/json' }),
      ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && retry && accessToken && !path.startsWith('/auth/')) {
    if (await refreshSession()) return api<T>(path, opts, false);
    accessToken = null;
    onSessionLost();
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

/** Server-Sent Events over fetch, so the bearer token travels in a header rather than the URL. */
export function subscribeEvents(onEvent: (type: string, data: any) => void): () => void {
  const ctrl = new AbortController();
  (async () => {
    while (!ctrl.signal.aborted) {
      try {
        const res = await fetch('/api/v1/events', { headers: { Authorization: `Bearer ${accessToken}` }, signal: ctrl.signal });
        if (res.status === 401) await refreshSession();
        if (!res.ok || !res.body) throw new Error('stream failed');
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const type = /^event: (.+)$/m.exec(chunk)?.[1];
            const data = /^data: (.+)$/m.exec(chunk)?.[1];
            if (type && data) onEvent(type, JSON.parse(data));
          }
        }
      } catch {
        /* reconnect below */
      }
      if (!ctrl.signal.aborted) await new Promise((r) => setTimeout(r, 3000));
    }
  })();
  return () => ctrl.abort();
}
