import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { LineChart } from '../components/LineChart';
import { DeviceStatus, ErrorBox, fmtDate, fmtDateTime, useApi } from '../components/ui';

interface PatientSummary {
  id: string;
  mrn: string;
  name: string;
  dob: string;
}
interface Patient extends PatientSummary {
  facilityId: string;
  phone: string | null;
  allergies: string | null;
  latestVitals: Record<string, { value: number; unit: string; recordedAt: string }>;
  devices: { id: string; asset_tag: string; kind: string; status: string; location: string }[];
}

const age = (dob: string) => Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 86_400_000));

export function Patients() {
  const [mrn, setMrn] = useState('');
  const [query, setQuery] = useState('');
  const { data, error } = useApi<PatientSummary[]>(`/patients${query ? `?mrn=${encodeURIComponent(query)}` : ''}`, [query]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Patients</h1>
          <div className="muted">Access is limited to your facility and is recorded in the audit log.</div>
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); setQuery(mrn.trim()); }}>
          <input aria-label="Search by MRN" placeholder="Exact MRN, e.g. MRN-100234" value={mrn} onChange={(e) => setMrn(e.target.value)} style={{ width: 240 }} />
          <button>Search</button>
          {query && <button type="button" onClick={() => { setMrn(''); setQuery(''); }}>Clear</button>}
        </form>
      </div>
      <ErrorBox error={error} />
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>MRN</th>
              <th>Date of birth</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/patients/${p.id}`}>
                    <strong>{p.name}</strong>
                  </Link>
                </td>
                <td>{p.mrn}</td>
                <td>
                  {fmtDate(p.dob)} <span className="muted">({age(p.dob)} y)</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.length === 0 && <div className="empty">No patients found.</div>}
      </div>
    </>
  );
}

const VITALS: { kind: string; title: string; unit: string; normal?: [number, number]; decimals?: number }[] = [
  { kind: 'heart_rate', title: 'Heart rate', unit: 'bpm', normal: [60, 100] },
  { kind: 'spo2', title: 'SpO₂', unit: '%', normal: [95, 100] },
  { kind: 'resp_rate', title: 'Respiratory rate', unit: 'br/min', normal: [12, 20] },
  { kind: 'temperature', title: 'Temperature', unit: '°C', normal: [36.1, 37.5], decimals: 1 },
];

export function PatientDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [breakGlass, setBreakGlass] = useState<string | null>(null);
  const headers = breakGlass ? { 'X-Break-Glass-Reason': breakGlass } : undefined;
  const [patient, setPatient] = useState<Patient | null>(null);
  const [vitals, setVitals] = useState<{ kind: string; value: number; recordedAt: string }[]>([]);
  const [notes, setNotes] = useState<{ id: string; author: string; createdAt: string; body: string }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const isClinician = user?.role === 'clinician';
  const isStaff = user?.role === 'clinician' || user?.role === 'admin';

  async function load(h = headers) {
    try {
      const p = await api<Patient>(`/patients/${id}`, { headers: h });
      setPatient(p);
      setVitals(await api(`/patients/${id}/vitals?limit=500`, { headers: h }));
      if (isStaff) setNotes(await api(`/patients/${id}/notes`, { headers: h }));
      setError(null);
    } catch (e) {
      setError(e);
    }
    setLoaded(id ?? null);
  }
  useEffect(() => {
    if (loaded !== id) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function addNote(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/patients/${id}/notes`, { method: 'POST', body: { body: note }, headers });
      setNote('');
      setNotes(await api(`/patients/${id}/notes`, { headers }));
    } catch (err) {
      setError(err);
    }
  }

  const denied = error instanceof ApiError && error.status === 403;

  if (denied && isClinician && !patient) {
    return (
      <div className="card" style={{ maxWidth: 560 }}>
        <h1>Restricted record</h1>
        <p className="muted">This patient is registered at another facility. In an emergency you may request break-glass access. Your reason, identity and every record you view will be logged and reviewed by the privacy office.</p>
        <form onSubmit={(e) => { e.preventDefault(); setBreakGlass(reason); void load({ 'X-Break-Glass-Reason': reason }); }}>
          <div className="field">
            <label htmlFor="r">Clinical reason (required)</label>
            <textarea id="r" rows={3} minLength={10} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} required />
          </div>
          <button className="primary">Request emergency access</button>
        </form>
      </div>
    );
  }

  const series = (kind: string) => vitals.filter((v) => v.kind === kind).map((v) => ({ t: v.recordedAt, v: v.value })).reverse();

  return (
    <>
      <ErrorBox error={error} />
      {breakGlass && <div className="notice" style={{ marginBottom: 16 }}>Break-glass access active — this session is being audited.</div>}
      {patient && (
        <>
          <div className="page-head">
            <div>
              {isStaff && <div className="small"><Link to="/patients">← Patients</Link></div>}
              <h1>{patient.name}</h1>
              <div className="muted">
                {patient.mrn} · DOB {fmtDate(patient.dob)} ({age(patient.dob)} y){patient.phone && ` · ${patient.phone}`}
              </div>
            </div>
            {patient.allergies && <div className="notice"><strong>Allergies:</strong> {patient.allergies}</div>}
          </div>
          <div className="grid grid-2" style={{ marginBottom: 16 }}>
            {VITALS.filter((v) => series(v.kind).length > 0).map((v) => (
              <LineChart key={v.kind} title={v.title} unit={v.unit} points={series(v.kind)} normal={v.normal} decimals={v.decimals} />
            ))}
            {vitals.length === 0 && <div className="card empty">No vitals recorded.</div>}
          </div>
          <div className="grid grid-2">
            {patient.devices.length > 0 && (
              <div className="card">
                <h2>Connected equipment</h2>
                {patient.devices.map((d) => (
                  <div key={d.id} className="row" style={{ padding: '6px 0' }}>
                    {isStaff ? <Link to={`/devices/${d.id}`}>{d.asset_tag}</Link> : <strong>{d.asset_tag}</strong>}
                    <span>{d.kind}</span>
                    <DeviceStatus status={d.status} />
                  </div>
                ))}
              </div>
            )}
            {isStaff && (
              <div className="card">
                <h2>Clinical notes</h2>
                {isClinician && (
                  <form onSubmit={addNote} style={{ marginBottom: 12 }}>
                    <textarea aria-label="New note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={20000} required />
                    <div style={{ marginTop: 8 }}><button className="primary">Add note</button></div>
                  </form>
                )}
                {notes.map((n) => (
                  <div key={n.id} style={{ padding: '8px 0', borderTop: '1px solid var(--grid)' }}>
                    <div className="small muted">{n.author} · {fmtDateTime(n.createdAt)}</div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                  </div>
                ))}
                {notes.length === 0 && <div className="empty">No notes.</div>}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
