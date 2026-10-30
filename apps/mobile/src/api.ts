import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

/**
 * Mobile API client. The refresh token is kept in the OS secure enclave (iOS Keychain /
 * Android Keystore) and only readable while the device is unlocked; the access token is memory-only.
 * Production builds must use an https:// API URL (ATS / cleartext traffic is disabled).
 */
const API_URL: string = (Constants.expoConfig?.extra?.apiUrl as string) ?? 'http://localhost:4000';
const RT_KEY = 'carebridge.refresh';
const STORE_OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function storeSession(res: { accessToken: string; refreshToken?: string }) {
  accessToken = res.accessToken;
  if (res.refreshToken) await SecureStore.setItemAsync(RT_KEY, res.refreshToken, STORE_OPTS);
}

export async function clearSession() {
  accessToken = null;
  await SecureStore.deleteItemAsync(RT_KEY, STORE_OPTS);
}

export async function hasStoredSession() {
  return !!(await SecureStore.getItemAsync(RT_KEY, STORE_OPTS));
}

export function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const refreshToken = await SecureStore.getItemAsync(RT_KEY, STORE_OPTS);
      if (!refreshToken) return false;
      const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        await clearSession();
        return false;
      }
      await storeSession(await res.json());
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined && { 'Content-Type': 'application/json' }),
      ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && retry && !path.startsWith('/auth/login') && !path.startsWith('/auth/mfa/verify')) {
    if (await refresh()) return api<T>(path, opts, false);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}
