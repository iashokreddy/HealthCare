import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { LineChart } from '../components/LineChart';
import { DeviceStatus, ErrorBox, fmtDate, fmtDateTime, PRIORITY_TONE, StatusPill, timeAgo, useApi } from '../components/ui';

export interface Device {
  id: string;
  facilityId: string;
  assetTag: string;
  kind: string;
  manufacturer: string;
  model: string;
  serial: string;
  location: string;
  status: string;
  firmware: string;
  riskClass: string;
  lastHeartbeatAt: string | null;
  nextServiceDue: string | null;
  batteryPct: number | null;
}
export interface WorkOrder {
  id: string;
  deviceId: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  assignedTo: string | null;
  createdAt: string;
  resolvedAt: string | null;
  device?: { assetTag: string; kind: string; location: string };
}

const isOverdue = (d: string | null) => !!d && new Date(d).getTime() < Date.now();

export function Devices() {
  const [status, setStatus] = useState('');
  const { data, error } = useApi<Device[]>(`/devices${status ? `?status=${status}` : ''}`, [status]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Medical equipment</h1>
          <div className="muted">Connected device fleet, health and preventive maintenance</div>
        </div>
        <div style={{ width: 200 }}>
          <label htmlFor="st">Status</label>
          <select id="st" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="online">Online</option>
            <option value="degraded">Degraded</option>
            <option value="offline">Offline</option>
            <option value="maintenance">Maintenance</option>
          </select>
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Asset</th>
              <th>Type</th>
              <th>Location</th>
              <th>Status</th>
              <th>Last heartbeat</th>
              <th>Service due</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((d) => (
              <tr key={d.id}>
                <td>
                  <Link to={`/devices/${d.id}`}>
                    <strong>{d.assetTag}</strong>
                  </Link>
                  <div className="small muted">Class {d.riskClass}</div>
                </td>
                <td>
                  {d.kind}
                  <div className="small muted">
                    {d.manufacturer} {d.model}
                  </div>
                </td>
                <td>{d.location}</td>
                <td>
                  <DeviceStatus status={d.status} />
                </td>
                <td className="muted">{timeAgo(d.lastHeartbeatAt)}</td>
                <td>{isOverdue(d.nextServiceDue) ? <StatusPill tone="critical">Overdue {fmtDate(d.nextServiceDue)}</StatusPill> : fmtDate(d.nextServiceDue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.length === 0 && <div className="empty">No devices match this filter.</div>}
      </div>
    </>
  );
}

const METRIC_LABEL: Record<string, { title: string; unit: string }> = {
  battery_pct: { title: 'Battery', unit: '%' },
  temperature_c: { title: 'Internal temperature', unit: '°C' },
  occlusion_pressure: { title: 'Line pressure', unit: 'mmHg' },
  heart_rate: { title: 'Heart rate', unit: 'bpm' },
  spo2: { title: 'SpO₂', unit: '%' },
};

export function DeviceDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const device = useApi<Device & { workOrders: WorkOrder[] }>(`/devices/${id}`, [id]);
  const telemetry = useApi<{ metric: string; value: number; at: string }[]>(`/devices/${id}/telemetry?limit=600`, [id]);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('medium');
  const [error, setError] = useState<unknown>(null);
  const canManage = user?.role === 'biomed_tech' || user?.role === 'admin';

  async function report(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/work-orders', { method: 'POST', body: { deviceId: id, title, priority } });
      setTitle('');
      void device.reload();
    } catch (err) {
      setError(err);
    }
  }
  async function setStatus(status: string) {
    try {
      await api(`/devices/${id}`, { method: 'PATCH', body: { status } });
      void device.reload();
    } catch (err) {
      setError(err);
    }
  }

  const d = device.data;
  const byMetric = new Map<string, { t: string; v: number }[]>();
  for (const s of telemetry.data ?? []) {
    if (!byMetric.has(s.metric)) byMetric.set(s.metric, []);
    byMetric.get(s.metric)!.push({ t: s.at, v: s.value });
  }

  return (
    <>
      <ErrorBox error={device.error ?? error} />
      {d && (
        <>
          <div className="page-head">
            <div>
              <div className="small">
                <Link to="/devices">← Equipment</Link>
              </div>
              <h1>
                {d.assetTag} · {d.kind}
              </h1>
              <div className="muted">
                {d.manufacturer} {d.model} · SN {d.serial} · {d.location}
              </div>
            </div>
            <div className="row">
              <DeviceStatus status={d.status} />
              {canManage && d.status !== 'maintenance' && <button onClick={() => setStatus('maintenance')}>Take out of service</button>}
              {canManage && d.status === 'maintenance' && <button onClick={() => setStatus('online')}>Return to service</button>}
            </div>
          </div>
          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            <div className="card"><div className="stat-label">Last heartbeat</div><div className="stat-value" style={{ fontSize: '1.3rem' }}>{timeAgo(d.lastHeartbeatAt)}</div></div>
            <div className="card"><div className="stat-label">Firmware</div><div className="stat-value" style={{ fontSize: '1.3rem' }}>{d.firmware}</div></div>
            <div className="card"><div className="stat-label">Risk class</div><div className="stat-value" style={{ fontSize: '1.3rem' }}>Class {d.riskClass}</div></div>
            <div className="card"><div className="stat-label">Next service</div><div className="stat-value" style={{ fontSize: '1.3rem' }}>{fmtDate(d.nextServiceDue)}</div></div>
          </div>
          {byMetric.size > 0 && (
            <div className="grid grid-2" style={{ marginBottom: 16 }}>
              {[...byMetric].map(([m, pts]) => (
                <LineChart key={m} title={METRIC_LABEL[m]?.title ?? m} unit={METRIC_LABEL[m]?.unit ?? ''} points={pts} decimals={m === 'temperature_c' ? 1 : 0} />
              ))}
            </div>
          )}
          <div className="grid grid-2">
            <div className="card">
              <h2>Work orders</h2>
              {d.workOrders.length === 0 && <div className="empty">No work orders.</div>}
              {d.workOrders.map((w) => (
                <div key={w.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--grid)' }}>
                  <div className="row">
                    <strong>{w.title}</strong>
                    <StatusPill tone={PRIORITY_TONE[w.priority] ?? 'neutral'}>{w.priority}</StatusPill>
                    <span className="muted small">{w.status.replace('_', ' ')}</span>
                  </div>
                  <div className="small muted">Opened {fmtDateTime(w.createdAt)}</div>
                </div>
              ))}
            </div>
            <form className="card" onSubmit={report}>
              <h2>Report a problem</h2>
              <div className="field">
                <label htmlFor="t">What’s wrong?</label>
                <input id="t" value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={200} required />
              </div>
              <div className="field">
                <label htmlFor="p">Priority</label>
                <select id="p" value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical — patient safety risk</option>
                </select>
              </div>
              <button className="primary">Create work order</button>
            </form>
          </div>
        </>
      )}
    </>
  );
}

export function WorkOrders() {
  const { user } = useAuth();
  const [status, setStatusFilter] = useState('open');
  const { data, error, reload } = useApi<WorkOrder[]>(`/work-orders${status ? `?status=${status}` : ''}`, [status]);
  const [actionError, setActionError] = useState<unknown>(null);
  const canManage = user?.role === 'biomed_tech' || user?.role === 'admin';

  async function update(id: string, body: object) {
    try {
      await api(`/work-orders/${id}`, { method: 'PATCH', body });
      void reload();
    } catch (e) {
      setActionError(e);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Work orders</h1>
          <div className="muted">Corrective and preventive maintenance queue</div>
        </div>
        <div style={{ width: 200 }}>
          <label htmlFor="ws">Status</label>
          <select id="ws" value={status} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
      </div>
      <ErrorBox error={error ?? actionError} />
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Priority</th>
              <th>Issue</th>
              <th>Device</th>
              <th>Status</th>
              <th>Opened</th>
              {canManage && <th />}
            </tr>
          </thead>
          <tbody>
            {data?.map((w) => (
              <tr key={w.id}>
                <td>
                  <StatusPill tone={PRIORITY_TONE[w.priority] ?? 'neutral'}>{w.priority}</StatusPill>
                </td>
                <td>
                  <strong>{w.title}</strong>
                  {w.description && <div className="small muted">{w.description}</div>}
                </td>
                <td>
                  <Link to={`/devices/${w.deviceId}`}>{w.device?.assetTag}</Link>
                  <div className="small muted">{w.device?.location}</div>
                </td>
                <td>{w.status.replace('_', ' ')}</td>
                <td className="muted">{fmtDateTime(w.createdAt)}</td>
                {canManage && (
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {w.status === 'open' && <button onClick={() => update(w.id, { status: 'in_progress', assignedTo: user!.id })}>Start</button>}
                    {w.status === 'in_progress' && <button onClick={() => update(w.id, { status: 'resolved' })}>Resolve</button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {data?.length === 0 && <div className="empty">Nothing here.</div>}
      </div>
    </>
  );
}
