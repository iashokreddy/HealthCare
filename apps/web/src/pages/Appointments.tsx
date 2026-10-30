import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, fmtDateTime, StatusPill, useApi } from '../components/ui';

interface Appointment {
  id: string;
  patientId: string;
  patientName: string;
  clinicianName: string;
  facilityName: string;
  startsAt: string;
  durationMin: number;
  reason: string;
  status: string;
  telehealth: boolean;
}

export function Appointments() {
  const { user } = useAuth();
  const list = useApi<Appointment[]>('/appointments');
  const clinicians = useApi<{ id: string; displayName: string; facilityName: string }[]>(user?.role === 'patient' ? '/users/clinicians' : null);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({ clinicianId: '', startsAt: '', reason: '', telehealth: true });

  async function book(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/appointments', {
        method: 'POST',
        body: { patientId: user!.patientId, clinicianId: form.clinicianId, startsAt: new Date(form.startsAt).toISOString(), reason: form.reason, telehealth: form.telehealth },
      });
      setForm({ clinicianId: '', startsAt: '', reason: '', telehealth: true });
      void list.reload();
    } catch (err) {
      setError(err);
    }
  }
  async function setStatus(id: string, status: string) {
    try {
      await api(`/appointments/${id}`, { method: 'PATCH', body: { status } });
      void list.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Appointments</h1>
          <div className="muted">{user?.role === 'patient' ? 'Your upcoming visits' : 'Your schedule'}</div>
        </div>
      </div>
      <ErrorBox error={list.error ?? error} />
      <div className="grid" style={{ gridTemplateColumns: user?.role === 'patient' ? 'minmax(0,2fr) minmax(280px,1fr)' : '1fr' }}>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                {user?.role !== 'patient' && <th>Patient</th>}
                <th>With</th>
                <th>Reason</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data?.map((a) => (
                <tr key={a.id}>
                  <td>
                    {fmtDateTime(a.startsAt)}
                    <div className="small muted">{a.durationMin} min · {a.telehealth ? 'Video visit' : 'In person'}</div>
                  </td>
                  {user?.role !== 'patient' && <td>{a.patientName}</td>}
                  <td>
                    {a.clinicianName}
                    <div className="small muted">{a.facilityName}</div>
                  </td>
                  <td>{a.reason}</td>
                  <td>
                    <StatusPill tone={a.status === 'cancelled' ? 'neutral' : a.status === 'completed' ? 'good' : 'warning'}>{a.status.replace('_', ' ')}</StatusPill>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {a.status === 'scheduled' && <button onClick={() => setStatus(a.id, 'cancelled')}>Cancel</button>}
                    {a.status === 'checked_in' && user?.role === 'clinician' && <button onClick={() => setStatus(a.id, 'completed')}>Complete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data?.length === 0 && <div className="empty">No appointments.</div>}
        </div>
        {user?.role === 'patient' && (
          <form className="card" onSubmit={book}>
            <h2>Book a visit</h2>
            <div className="field">
              <label htmlFor="c">Clinician</label>
              <select id="c" value={form.clinicianId} onChange={(e) => setForm({ ...form, clinicianId: e.target.value })} required>
                <option value="">Choose…</option>
                {clinicians.data?.map((c) => (
                  <option key={c.id} value={c.id}>{c.displayName} — {c.facilityName}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="w">Date &amp; time</label>
              <input id="w" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="rs">Reason for visit</label>
              <textarea id="rs" rows={3} maxLength={1000} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required />
            </div>
            <div className="field row">
              <input id="th" type="checkbox" style={{ width: 'auto' }} checked={form.telehealth} onChange={(e) => setForm({ ...form, telehealth: e.target.checked })} />
              <label htmlFor="th" style={{ margin: 0 }}>Video visit</label>
            </div>
            <button className="primary">Request appointment</button>
          </form>
        )}
      </div>
    </>
  );
}
