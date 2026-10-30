import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { api, ApiError } from '../api';
import type { User } from '../App';
import { useTheme } from '../theme';

interface Chart {
  name: string;
  allergies: string | null;
  latestVitals: Record<string, { value: number; unit: string; recordedAt: string }>;
}
interface Appointment {
  id: string;
  clinicianName: string;
  facilityName: string;
  startsAt: string;
  reason: string;
  status: string;
  telehealth: boolean;
}

const LABEL: Record<string, string> = { heart_rate: 'Heart rate', spo2: 'SpO₂', resp_rate: 'Respiratory rate', temperature: 'Temperature', bp_systolic: 'BP systolic', bp_diastolic: 'BP diastolic' };

export function PatientHome({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { s } = useTheme();
  const [chart, setChart] = useState<Chart | null>(null);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setChart(await api<Chart>(`/patients/${user.patientId}`));
      setAppts(await api<Appointment[]>('/appointments'));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load your record');
    } finally {
      setLoading(false);
    }
  }, [user.patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancel(id: string) {
    await api(`/appointments/${id}`, { method: 'PATCH', body: { status: 'cancelled' } });
    void load();
  }

  return (
    <ScrollView contentContainerStyle={s.pad} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={s.h1}>Hi, {user.displayName.split(' ')[0]}</Text>
        <TouchableOpacity style={s.ghost} onPress={onLogout} accessibilityRole="button">
          <Text style={s.ghostText}>Sign out</Text>
        </TouchableOpacity>
      </View>
      {error && <Text style={s.error}>{error}</Text>}
      {chart?.allergies && (
        <View style={s.card}>
          <Text style={s.label}>Allergies</Text>
          <Text style={s.text}>{chart.allergies}</Text>
        </View>
      )}
      <Text style={s.h2}>Latest vitals</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {chart &&
          Object.entries(chart.latestVitals).map(([k, v]) => (
            <View key={k} style={[s.card, { flexBasis: '47%', flexGrow: 1 }]} accessible accessibilityLabel={`${LABEL[k] ?? k} ${v.value} ${v.unit}`}>
              <Text style={s.muted}>{LABEL[k] ?? k}</Text>
              <Text style={s.big}>
                {v.value} <Text style={s.muted}>{v.unit}</Text>
              </Text>
              <Text style={s.muted}>{new Date(v.recordedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
            </View>
          ))}
      </View>
      <Text style={s.h2}>Appointments</Text>
      {appts.length === 0 && <Text style={s.muted}>No upcoming appointments.</Text>}
      {appts.map((a) => (
        <View key={a.id} style={s.card}>
          <Text style={[s.text, { fontWeight: '700' }]}>{new Date(a.startsAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text>
          <Text style={s.text}>
            {a.clinicianName} · {a.telehealth ? 'Video visit' : a.facilityName}
          </Text>
          <Text style={s.muted}>{a.reason}</Text>
          <Text style={s.muted}>Status: {a.status.replace('_', ' ')}</Text>
          {a.status === 'scheduled' && (
            <TouchableOpacity style={[s.ghost, { marginTop: 8, alignSelf: 'flex-start' }]} onPress={() => cancel(a.id)} accessibilityRole="button">
              <Text style={s.ghostText}>Cancel</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
    </ScrollView>
  );
}
