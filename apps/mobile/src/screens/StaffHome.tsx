import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { api, ApiError } from '../api';
import type { User } from '../App';
import { STATUS, useTheme } from '../theme';

interface Alert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  createdAt: string;
}
interface Device {
  id: string;
  assetTag: string;
  kind: string;
  location: string;
  status: string;
}

const DEVICE_TONE: Record<string, keyof typeof STATUS> = { online: 'good', degraded: 'serious', offline: 'critical', maintenance: 'neutral' };
const SEVERITY_TONE: Record<string, keyof typeof STATUS> = { info: 'neutral', warning: 'warning', critical: 'critical' };
const ICON: Record<keyof typeof STATUS, string> = { good: '✓', warning: '!', serious: '!', critical: '✕', neutral: '–' };

/** Status shown with icon + text, colour as reinforcement only. */
function Pill({ tone, label }: { tone: keyof typeof STATUS; label: string }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}>
      <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: STATUS[tone], alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 10, fontWeight: '800', color: tone === 'warning' || tone === 'serious' ? '#0b0b0b' : '#fff' }}>{ICON[tone]}</Text>
      </View>
      <Text style={{ color: c.text, fontWeight: '600', fontSize: 13 }}>{label}</Text>
    </View>
  );
}

export function StaffHome({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { s } = useTheme();
  const [tab, setTab] = useState<'alerts' | 'devices'>('alerts');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, d] = await Promise.all([api<Alert[]>('/alerts?open=true'), api<Device[]>('/devices')]);
      setAlerts(a);
      setDevices(d);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function ack(id: string) {
    try {
      await api(`/alerts/${id}/ack`, { method: 'POST' });
      setAlerts((l) => l.filter((a) => a.id !== id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not acknowledge');
    }
  }

  return (
    <ScrollView contentContainerStyle={s.pad} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View>
          <Text style={s.h1}>{user.displayName}</Text>
          <Text style={s.muted}>{user.role.replace('_', ' ')}</Text>
        </View>
        <TouchableOpacity style={s.ghost} onPress={onLogout} accessibilityRole="button">
          <Text style={s.ghostText}>Sign out</Text>
        </TouchableOpacity>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }} accessibilityRole="tablist">
        {(['alerts', 'devices'] as const).map((t) => (
          <TouchableOpacity key={t} style={[s.ghost, tab === t && { borderWidth: 2 }]} onPress={() => setTab(t)} accessibilityRole="tab" accessibilityState={{ selected: tab === t }}>
            <Text style={s.ghostText}>{t === 'alerts' ? `Alerts (${alerts.length})` : `Equipment (${devices.length})`}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {error && <Text style={s.error}>{error}</Text>}
      {tab === 'alerts' &&
        (alerts.length === 0 ? (
          <Text style={s.muted}>No open alerts — all clear.</Text>
        ) : (
          alerts.map((a) => (
            <View key={a.id} style={[s.card, { gap: 6 }]}>
              <Pill tone={SEVERITY_TONE[a.severity] ?? 'neutral'} label={a.severity} />
              <Text style={s.text}>{a.message}</Text>
              <Text style={s.muted}>{new Date(a.createdAt).toLocaleString()}</Text>
              <TouchableOpacity style={[s.ghost, { alignSelf: 'flex-start' }]} onPress={() => ack(a.id)} accessibilityRole="button">
                <Text style={s.ghostText}>Acknowledge</Text>
              </TouchableOpacity>
            </View>
          ))
        ))}
      {tab === 'devices' &&
        devices.map((d) => (
          <View key={d.id} style={[s.card, { gap: 4 }]}>
            <Text style={[s.text, { fontWeight: '700' }]}>
              {d.assetTag} · {d.kind}
            </Text>
            <Text style={s.muted}>{d.location}</Text>
            <Pill tone={DEVICE_TONE[d.status] ?? 'neutral'} label={d.status} />
          </View>
        ))}
    </ScrollView>
  );
}
