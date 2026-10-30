import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, subscribeEvents } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, fmtDateTime, SEVERITY_TONE, StatTile, StatusPill, useApi } from '../components/ui';

interface Summary {
  devices: Record<string, number>;
  fleetAvailabilityPct: number;
  openAlerts: Record<string, number>;
  workOrders: Record<string, number>;
  servicesDueIn14Days: number;
}
export interface Alert {
  id: string;
  deviceId: string | null;
  patientId: string | null;
  severity: 'info' | 'warning' | 'critical';
  kind: string;
  message: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

export function Dashboard() {
  const { user } = useAuth();
  const summary = useApi<Summary>('/dashboard/summary');
  const alerts = useApi<Alert[]>('/alerts?open=true&limit=50');
  const [live, setLive] = useState(false);
  const [ackError, setAckError] = useState<unknown>(null);

  // Live updates: any device/alert event refreshes the board.
  useEffect(() => {
    let t: number | undefined;
    const unsub = subscribeEvents((type) => {
      setLive(true);
      if (type.startsWith('alert.') || type === 'device.status' || type === 'workorder.updated') {
        window.clearTimeout(t);
        t = window.setTimeout(() => {
          void summary.reload();
          void alerts.reload();
        }, 300);
      }
    });
    setLive(true);
    return () => {
      unsub();
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ack(id: string) {
    try {
      await api(`/alerts/${id}/ack`, { method: 'POST' });
      alerts.setData((list) => list?.filter((a) => a.id !== id) ?? null);
      void summary.reload();
    } catch (e) {
      setAckError(e);
    }
  }

  const s = summary.data;
  const total = s ? Object.values(s.devices).reduce((a, b) => a + b, 0) : 0;
  const openWo = s ? (s.workOrders.open ?? 0) + (s.workOrders.in_progress ?? 0) : 0;
  const critical = s?.openAlerts.critical ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Operations overview</h1>
          <div className="muted">Welcome back, {user?.displayName}</div>
        </div>
        <span className="small muted">
          {live && <span className="live-dot" aria-hidden="true" />}
          {live ? 'Live' : 'Connecting…'}
        </span>
      </div>
      <ErrorBox error={summary.error ?? alerts.error ?? ackError} />
      {s && (
        <div className="grid grid-4" style={{ marginBottom: 20 }}>
          <StatTile label="Fleet availability" value={`${s.fleetAvailabilityPct}%`} sub={`${(s.devices.online ?? 0) + (s.devices.degraded ?? 0)} of ${total} devices in service`} />
          <StatTile label="Open critical alerts" value={critical} sub={`${s.openAlerts.warning ?? 0} warnings`} />
          <StatTile label="Active work orders" value={openWo} sub={`${s.workOrders.in_progress ?? 0} in progress`} />
          <StatTile label="Service due ≤ 14 days" value={s.servicesDueIn14Days} sub="Preventive maintenance" />
        </div>
      )}
      <div className="card">
        <h2>Open alerts</h2>
        {alerts.data && alerts.data.length === 0 && <div className="empty">No open alerts — all clear.</div>}
        {alerts.data && alerts.data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Alert</th>
                  <th>Raised</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {alerts.data.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <StatusPill tone={SEVERITY_TONE[a.severity] ?? 'neutral'}>{a.severity}</StatusPill>
                    </td>
                    <td>
                      {a.message}
                      <div className="small">
                        {a.deviceId && <Link to={`/devices/${a.deviceId}`}>Device</Link>}
                        {a.deviceId && a.patientId && ' · '}
                        {a.patientId && user?.role !== 'biomed_tech' && <Link to={`/patients/${a.patientId}`}>Patient chart</Link>}
                      </div>
                    </td>
                    <td className="muted">{fmtDateTime(a.createdAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button onClick={() => ack(a.id)}>Acknowledge</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
