import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, refreshSession, setAccessToken, setSessionLostHandler } from './api';

export type Role = 'patient' | 'clinician' | 'biomed_tech' | 'admin';
export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  facilityId: string | null;
  patientId: string | null;
  mfaEnabled: boolean;
  amr: string[];
}

interface AuthState {
  user: User | null;
  loading: boolean;
  login(email: string, password: string): Promise<{ mfaToken?: string }>;
  verifyMfa(mfaToken: string, code: string): Promise<void>;
  logout(): Promise<void>;
  reload(): Promise<void>;
  setSession(accessToken: string): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Auto sign-out after inactivity — shared workstations are common on hospital floors. */
const IDLE_TIMEOUT_MS = 15 * 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const idleTimer = useRef<number | undefined>(undefined);

  const reload = useCallback(async () => {
    setUser(await api<User>('/auth/me'));
  }, []);

  const setSession = useCallback(
    async (token: string) => {
      setAccessToken(token);
      await reload();
    },
    [reload],
  );

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* session may already be gone */
    }
    setAccessToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setSessionLostHandler(() => setUser(null));
    // Restore the session from the HttpOnly refresh cookie on page load.
    refreshSession()
      .then(async (ok) => {
        if (ok) await reload();
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [reload]);

  useEffect(() => {
    if (!user) return;
    const reset = () => {
      window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => void logout(), IDLE_TIMEOUT_MS);
    };
    const events = ['mousemove', 'keydown', 'pointerdown', 'scroll'] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      window.clearTimeout(idleTimer.current);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [user, logout]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api<{ accessToken?: string; mfaRequired?: boolean; mfaToken?: string }>('/auth/login', {
        method: 'POST',
        body: { email, password, client: 'web' },
      });
      if (res.mfaRequired) return { mfaToken: res.mfaToken };
      await setSession(res.accessToken!);
      return {};
    },
    [setSession],
  );

  const verifyMfa = useCallback(
    async (mfaToken: string, code: string) => {
      const res = await api<{ accessToken: string }>('/auth/mfa/verify', { method: 'POST', body: { mfaToken, code, client: 'web' } });
      await setSession(res.accessToken);
    },
    [setSession],
  );

  return <AuthContext.Provider value={{ user, loading, login, verifyMfa, logout, reload, setSession }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

export const ROLE_LABEL: Record<Role, string> = {
  patient: 'Patient',
  clinician: 'Clinician',
  biomed_tech: 'Biomedical Tech',
  admin: 'Administrator',
};
