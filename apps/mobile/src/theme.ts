import { StyleSheet, useColorScheme } from 'react-native';

const light = { bg: '#f4f4f2', card: '#fcfcfb', border: '#dddcd7', text: '#0b0b0b', text2: '#52514e', muted: '#6f6e69', accent: '#2a78d6' };
const dark = { bg: '#121211', card: '#1a1a19', border: '#383835', text: '#f0efec', text2: '#c3c2b7', muted: '#9a998f', accent: '#3987e5' };
export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', neutral: '#8a8984' } as const;

export function useTheme() {
  const c = useColorScheme() === 'dark' ? dark : light;
  const s = StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    pad: { padding: 16, gap: 12 },
    card: { backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 12, padding: 14 },
    h1: { fontSize: 24, fontWeight: '700', color: c.text },
    h2: { fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 6 },
    text: { fontSize: 15, color: c.text },
    muted: { fontSize: 13, color: c.muted },
    label: { fontSize: 13, fontWeight: '600', color: c.text2, marginBottom: 4 },
    input: { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 16, color: c.text, backgroundColor: c.card },
    button: { backgroundColor: c.accent, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
    buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
    ghost: { borderColor: c.border, borderWidth: 1, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14, alignItems: 'center' },
    ghostText: { color: c.text, fontWeight: '600' },
    error: { color: STATUS.critical, fontSize: 14 },
    big: { fontSize: 28, fontWeight: '700', color: c.text, fontVariant: ['tabular-nums'] },
  });
  return { c, s };
}
