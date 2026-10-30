import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ROLE_LABEL, useAuth, type Role } from '../auth';
import { ErrorBox, fmtDateTime, StatusPill, useApi } from '../components/ui';

interface AuditEntry {
  seq: number;
  at: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: 'success' | 'denied' | 'error';
  ip: string | null;
  detail: Record<string, unknown> | null;
}

export function AuditLog() {
  const [action, setAction] = useState('');
  const { data, error } = useApi<AuditEntry[]>(`/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}`, [action]);
  const [verify, setVerify] = useState<{ ok: boolean; count: number; brokenAtSeq?: number } | null>(null);
  const [vErr, setVErr] = useState<unknown>(null);

  async function runVerify() {
    try {
      setVerify(await api('/audit/verify'));
    } catch (e) {
      setVErr(e);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <div className="muted">Tamper-evident record of every access to patient data and every security event.</div>
        </div>
        <div className="row">
          <select aria-label="Filter by action" value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 200 }}>
            <option value="">All actions</option>
            <option value="phi.">PHI access</option>
            <option value="auth.">Authentication</option>
            <option value="authz.">Access denied</option>
            <option value="device.">Devices</option>
            <option value="user.">User admin</option>
          </select>
          <button onClick={runVerify}>Verify integrity</button>
        </div>
      </div>
      <ErrorBox error={error ?? vErr} />
      {verify && (
        <div className="card" style={{ marginBottom: 16 }}>
          {verify.ok ? (
            <StatusPill tone="good">Chain intact — {verify.count} entries verified</StatusPill>
          ) : (
            <StatusPill tone="critical">Tampering detected at entry #{verify.brokenAtSeq}</StatusPill>
          )}
        </div>
      )}
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Resource</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((e) => (
              <tr key={e.seq}>
                <td className="num muted">{e.seq}</td>
                <td className="muted">{fmtDateTime(e.at)}</td>
                <td>
                  {e.actor_role ?? '—'}
                  <div className="small muted">{e.actor_id?.slice(0, 8) ?? ''}</div>
                </td>
                <td>
                  <code>{e.action}</code>
                  {e.detail?.breakGlass ? <div><StatusPill tone="warning">Break-glass</StatusPill></div> : null}
                </td>
                <td>
                  {e.resource_type}
                  <div className="small muted">{e.resource_id?.slice(0, 8) ?? ''}</div>
                </td>
                <td>
                  <StatusPill tone={e.outcome === 'success' ? 'good' : e.outcome === 'denied' ? 'serious' : 'critical'}>{e.outcome}</StatusPill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  facilityId: string | null;
  mfaEnabled: boolean;
  locked: boolean;
  disabled: boolean;
}

export function Users() {
  const { data, error, reload } = useApi<AdminUser[]>('/users');
  const [err, setErr] = useState<unknown>(null);
  async function patch(id: string, body: object) {
    try {
      await api(`/users/${id}`, { method: 'PATCH', body });
      void reload();
    } catch (e) {
      setErr(e);
    }
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <div className="muted">Accounts, roles and security state</div>
        </div>
      </div>
      <ErrorBox error={error ?? err} />
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Facility</th>
              <th>MFA</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.map((u) => (
              <tr key={u.id}>
                <td>
                  <strong>{u.displayName}</strong>
                  <div className="small muted">{u.email}</div>
                </td>
                <td>{ROLE_LABEL[u.role]}</td>
                <td>{u.facilityId ?? '—'}</td>
                <td>{u.mfaEnabled ? <StatusPill tone="good">Enabled</StatusPill> : <StatusPill tone={u.role === 'patient' ? 'neutral' : 'warning'}>Not set up</StatusPill>}</td>
                <td>
                  {u.disabled ? <StatusPill tone="critical">Disabled</StatusPill> : u.locked ? <StatusPill tone="serious">Locked</StatusPill> : <StatusPill tone="good">Active</StatusPill>}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {u.locked && <button onClick={() => patch(u.id, { unlock: true })}>Unlock</button>}{' '}
                  <button onClick={() => patch(u.id, { disabled: !u.disabled })}>{u.disabled ? 'Enable' : 'Disable'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Security() {
  const { user, setSession } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function start() {
    try {
      setSetup(await api('/auth/mfa/setup', { method: 'POST' }));
    } catch (e) {
      setError(e);
    }
  }
  async function enable(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api<{ accessToken: string }>('/auth/mfa/enable', { method: 'POST', body: { code, client: 'web' } });
      await setSession(res.accessToken);
      setDone(true);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <h1>Account security</h1>
      <p className="muted">Signed in as {user?.email}</p>
      <ErrorBox error={error} />
      <div className="card">
        <h2>Two-step verification</h2>
        {user?.mfaEnabled || done ? (
          <StatusPill tone="good">Enabled — codes from your authenticator app are required at sign-in</StatusPill>
        ) : !setup ? (
          <>
            <p>Protect your account with a time-based code from an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…).</p>
            {user?.role !== 'patient' && <div className="notice" style={{ marginBottom: 12 }}>Required for staff accounts before accessing patient data or equipment controls in production.</div>}
            <button className="primary" onClick={start}>Set up</button>
          </>
        ) : (
          <form onSubmit={enable}>
            <p>Add this key to your authenticator app, then enter the 6-digit code it shows.</p>
            <div className="field">
              <label>Setup key</label>
              <code style={{ fontSize: '1rem', letterSpacing: '0.08em', wordBreak: 'break-all' }}>{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
              <div className="small muted" style={{ marginTop: 6, wordBreak: 'break-all' }}>{setup.otpauthUri}</div>
            </div>
            <div className="field">
              <label htmlFor="mc">Code</label>
              <input id="mc" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
            </div>
            <button className="primary">Turn on</button>
          </form>
        )}
      </div>
    </div>
  );
}
