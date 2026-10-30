import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { api, ApiError, storeSession } from '../api';
import { useTheme } from '../theme';

type LoginResponse = { accessToken?: string; refreshToken?: string; mfaRequired?: boolean; mfaToken?: string };

export function Login({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const { s, c } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = mfaToken
        ? await api<LoginResponse>('/auth/mfa/verify', { method: 'POST', body: { mfaToken, code, client: 'mobile' } })
        : await api<LoginResponse>('/auth/login', { method: 'POST', body: { email, password, client: 'mobile' } });
      if (res.mfaRequired) {
        setMfaToken(res.mfaToken!);
        setPassword('');
      } else {
        await storeSession({ accessToken: res.accessToken!, refreshToken: res.refreshToken });
        await onSignedIn();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Unable to reach CareBridge. Check your connection.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[s.pad, { marginTop: 60 }]}>
      <Text style={s.h1}>{mfaToken ? 'Verify it’s you' : 'CareBridge'}</Text>
      <Text style={s.muted}>{mfaToken ? 'Enter the 6-digit code from your authenticator app.' : 'Sign in to continue'}</Text>
      {error && <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text>}
      {mfaToken ? (
        <View>
          <Text style={s.label}>Verification code</Text>
          <TextInput style={s.input} value={code} onChangeText={(t) => setCode(t.replace(/\D/g, ''))} keyboardType="number-pad" maxLength={6} textContentType="oneTimeCode" autoComplete="one-time-code" autoFocus />
        </View>
      ) : (
        <>
          <View>
            <Text style={s.label}>Email</Text>
            <TextInput style={s.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" textContentType="username" autoComplete="email" placeholderTextColor={c.muted} />
          </View>
          <View>
            <Text style={s.label}>Password</Text>
            <TextInput style={s.input} value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="password" />
          </View>
        </>
      )}
      <TouchableOpacity style={[s.button, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy} accessibilityRole="button">
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>{mfaToken ? 'Verify' : 'Sign in'}</Text>}
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}
