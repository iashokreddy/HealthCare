import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { ROLE_LABEL, useAuth, type Role } from './auth';
import { Appointments } from './pages/Appointments';
import { AuditLog, Security, Users } from './pages/Admin';
import { Dashboard } from './pages/Dashboard';
import { DeviceDetail, Devices, WorkOrders } from './pages/Devices';
import { Login } from './pages/Login';
import { PatientDetail, Patients } from './pages/Patients';

const NAV: { to: string; label: string; roles: Role[] }[] = [
  { to: '/dashboard', label: 'Overview', roles: ['clinician', 'biomed_tech', 'admin'] },
  { to: '/patients', label: 'Patients', roles: ['clinician', 'admin'] },
  { to: '/my-health', label: 'My health', roles: ['patient'] },
  { to: '/appointments', label: 'Appointments', roles: ['patient', 'clinician', 'admin'] },
  { to: '/devices', label: 'Equipment', roles: ['clinician', 'biomed_tech', 'admin'] },
  { to: '/work-orders', label: 'Work orders', roles: ['clinician', 'biomed_tech', 'admin'] },
  { to: '/users', label: 'Users', roles: ['admin'] },
  { to: '/audit', label: 'Audit log', roles: ['admin'] },
  { to: '/security', label: 'Security', roles: ['patient', 'clinician', 'biomed_tech', 'admin'] },
];

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">CB</span> CareBridge
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.filter((n) => n.roles.includes(user.role)).map((n) => (
            <NavLink key={n.to} to={n.to}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div>
            <strong>{user.displayName}</strong>
          </div>
          <div className="muted">{ROLE_LABEL[user.role]}</div>
          <button className="link" onClick={() => void logout()} style={{ marginTop: 6 }}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

function Guard({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) return <Navigate to="/" replace />;
  return <Shell>{children}</Shell>;
}

function Home() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'patient' ? '/my-health' : '/dashboard'} replace />;
}

function MyHealth() {
  const { user } = useAuth();
  return user?.patientId ? <Navigate to={`/patients/${user.patientId}`} replace /> : <div className="empty">No patient record linked.</div>;
}

const STAFF: Role[] = ['clinician', 'biomed_tech', 'admin'];

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="login-wrap muted">Loading…</div>;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
        <Route path="/" element={<Home />} />
        <Route path="/dashboard" element={<Guard roles={STAFF}><Dashboard /></Guard>} />
        <Route path="/patients" element={<Guard roles={['clinician', 'admin']}><Patients /></Guard>} />
        <Route path="/patients/:id" element={<Guard roles={['patient', 'clinician', 'admin']}><PatientDetail /></Guard>} />
        <Route path="/my-health" element={<Guard roles={['patient']}><MyHealth /></Guard>} />
        <Route path="/appointments" element={<Guard roles={['patient', 'clinician', 'admin']}><Appointments /></Guard>} />
        <Route path="/devices" element={<Guard roles={STAFF}><Devices /></Guard>} />
        <Route path="/devices/:id" element={<Guard roles={STAFF}><DeviceDetail /></Guard>} />
        <Route path="/work-orders" element={<Guard roles={STAFF}><WorkOrders /></Guard>} />
        <Route path="/users" element={<Guard roles={['admin']}><Users /></Guard>} />
        <Route path="/audit" element={<Guard roles={['admin']}><AuditLog /></Guard>} />
        <Route path="/security" element={<Guard roles={['patient', ...STAFF]}><Security /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
