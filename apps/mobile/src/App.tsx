import * as LocalAuthentication from 'expo-local-authentication';
import * as ScreenCapture from 'expo-screen-capture';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, SafeAreaView, Text, TouchableOpacity, View } from 'react-native';
import { api, clearSession, hasStoredSession, refresh } from './api';
import { Login } from './screens/Login';
import { PatientHome } from './screens/PatientHome';
import { StaffHome } from './screens/StaffHome';
import { useTheme } from './theme';

export interface User {
  id: string;
  displayName: string;
  role: 'patient' | 'clinician' | 'biomed_tech' | 'admin';
  patientId: string | null;
}

/** Re-lock after this long in the background. */
const LOCK_AFTER_MS = 2 * 60_000;

export default function App() {
  const { s } = useTheme();
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [locked, setLocked] = useState(false);
  const backgroundedAt = useRef<number | null>(null);

  // Block screenshots / screen recording and hide content in the app switcher (PHI on screen).
  useEffect(() => {
    void ScreenCapture.preventScreenCaptureAsync();
  }, []);

  const loadUser = useCallback(async () => setUser(await api<User>('/auth/me')), []);

  const unlock = useCallback(async () => {
    const hasBio = (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
    if (hasBio) {
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock CareBridge', disableDeviceFallback: false });
      if (!r.success) return;
    }
    if (await refresh()) {
      await loadUser();
      setLocked(false);
    } else {
      setUser(null);
      setLocked(false);
    }
  }, [loadUser]);

  useEffect(() => {
    (async () => {
      if (await hasStoredSession()) await unlock();
      setBooting(false);
    })();
  }, [unlock]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') backgroundedAt.current = Date.now();
      if (state === 'active' && backgroundedAt.current && Date.now() - backgroundedAt.current > LOCK_AFTER_MS && user) setLocked(true);
    });
    return () => sub.remove();
  }, [user]);

  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* already gone */
    }
    await clearSession();
    setUser(null);
  }

  let body;
  if (booting) body = <Text style={[s.muted, { textAlign: 'center', marginTop: 80 }]}>Loading…</Text>;
  else if (locked)
    body = (
      <View style={[s.pad, { marginTop: 80 }]}>
        <Text style={s.h1}>CareBridge is locked</Text>
        <TouchableOpacity style={s.button} onPress={unlock} accessibilityRole="button">
          <Text style={s.buttonText}>Unlock</Text>
        </TouchableOpacity>
      </View>
    );
  else if (!user) body = <Login onSignedIn={loadUser} />;
  else if (user.role === 'patient') body = <PatientHome user={user} onLogout={logout} />;
  else body = <StaffHome user={user} onLogout={logout} />;

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar style="auto" />
      {body}
    </SafeAreaView>
  );
}
