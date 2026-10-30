import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError, api } from '../api';

export type StatusTone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral';

const ICON: Record<StatusTone, string> = { good: '✓', warning: '!', serious: '!', critical: '✕', neutral: '–' };

/** Status is always conveyed by icon + text label, with color as reinforcement only. */
export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`pill pill-${tone}`}>
      <span className="pill-icon" aria-hidden="true">
        {ICON[tone]}
      </span>
      {children}
    </span>
  );
}

export const DEVICE_TONE: Record<string, StatusTone> = { online: 'good', degraded: 'serious', offline: 'critical', maintenance: 'neutral' };
export const SEVERITY_TONE: Record<string, StatusTone> = { info: 'neutral', warning: 'warning', critical: 'critical' };
export const PRIORITY_TONE: Record<string, StatusTone> = { low: 'neutral', medium: 'warning', high: 'serious', critical: 'critical' };

export function DeviceStatus({ status }: { status: string }) {
  return <StatusPill tone={DEVICE_TONE[status] ?? 'neutral'}>{status[0]!.toUpperCase() + status.slice(1)}</StatusPill>;
}

export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
  return (
    <div className="error" role="alert">
      {msg}
    </div>
  );
}

/** Minimal data hook: loads on mount / when deps change, exposes reload. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

export const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
export function timeAgo(iso: string | null) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
