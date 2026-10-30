import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { ErrorBox } from '../components/ui';

const DEMO = ['dr.chen@carebridge.test', 'tech.lee@carebridge.test', 'admin@carebridge.test', 'jordan@carebridge.test'];

export function Login() {
  const { login, verifyMfa } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) await verifyMfa(mfaToken, code);
      else {
        const res = await login(email, password);
        if (res.mfaToken) setMfaToken(res.mfaToken);
      }
    } catch (err) {
      setError(err);
      if (mfaToken) setCode('');
    } finally {
      setBusy(false);
      setPassword((p) => (mfaToken ? '' : p));
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit} autoComplete="on">
        <div className="brand" style={{ padding: '0 0 14px' }}>
          <span className="brand-mark">CB</span> CareBridge
        </div>
        <h1>{mfaToken ? 'Verify it’s you' : 'Sign in'}</h1>
        <p className="muted small" style={{ marginTop: 0 }}>
          {mfaToken ? 'Enter the 6-digit code from your authenticator app.' : 'Secure access for patients, clinicians and biomedical engineering.'}
        </p>
        <ErrorBox error={error} />
        {mfaToken ? (
          <div className="field">
            <label htmlFor="code">Verification code</label>
            <input id="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
          </>
        )}
        <button className="primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Please wait…' : mfaToken ? 'Verify' : 'Sign in'}
        </button>
        {mfaToken && (
          <p className="small" style={{ textAlign: 'center' }}>
            <button type="button" className="link" onClick={() => setMfaToken(null)}>
              Start over
            </button>
          </p>
        )}
        {import.meta.env.DEV && !mfaToken && (
          <div className="demo-accounts">
            Demo accounts (password <code>CareBridge!2026</code>):
            <div>
              {DEMO.map((d) => (
                <button type="button" key={d} onClick={() => { setEmail(d); setPassword('CareBridge!2026'); }}>
                  {d.split('@')[0]}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
