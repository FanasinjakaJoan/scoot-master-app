import React, { useState } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Alert } from '../lib/alert';
import { colors, radius, textStyles } from '../theme';
import { Button } from '../components/Buttons';
import { InstallAppCard } from '../components/InstallAppCard';
import { useApp } from '../store/AppStore';

export function LoginScreen() {
  const { doLogin } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!username.trim() || !password) {
      setError('Saisissez votre identifiant et votre mot de passe.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await doLogin(username.trim(), password);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Erreur de connexion.';
      if (msg.includes('réseau')) {
        Alert.alert('Hors ligne',
          'Impossible de contacter le serveur. Vérifiez la connexion, ou utilisez un compte déjà connecté.', [
            { text: 'OK' },
          ]);
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.brand}>
          <Text style={styles.logo}>🏍️</Text>
          <Text style={styles.title}>Scoot Master</Text>
          <Text style={styles.sub}>Motos 4T d'occasion — catalogue, ventes &amp; clients, hors ligne inclus.</Text>
        </View>

        <View style={styles.form}>
          <Text style={textStyles.label}>Identifiant</Text>
          <TextInput
            value={username}
            onChangeText={setUsername}
            placeholder="ex. admin"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Text style={textStyles.label}>Mot de passe</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={colors.textMuted}
            secureTextEntry
            onSubmitEditing={submit}
            style={styles.input}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button title={busy ? 'Connexion…' : 'Se connecter'} onPress={submit} disabled={busy} />
          <View style={styles.demo}>
            <Text style={styles.demoText}>
              Comptes de démo : <Text style={styles.demoStrong}>admin / admin123</Text> · <Text style={styles.demoStrong}>vendeur / vendeur123</Text>
            </Text>
          </View>
        </View>

        {/* Raccourci d'installation : APK Android ou application de bureau */}
        <InstallAppCard compact />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, justifyContent: 'center', gap: 28 },
  brand: { alignItems: 'center', gap: 6 },
  logo: { fontSize: 56 },
  title: { fontSize: 30, fontWeight: '800', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, textAlign: 'center' },
  form: {
    backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.border, padding: 20, gap: 6,
  },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text,
    marginBottom: 8, backgroundColor: colors.background,
  },
  error: { color: colors.danger, fontSize: 13, marginBottom: 6 },
  demo: {
    marginTop: 12, backgroundColor: colors.infoSoft, borderRadius: radius.md,
    padding: 10, borderWidth: 1, borderColor: colors.info + '33',
  },
  demoText: { fontSize: 12, color: colors.textMuted },
  demoStrong: { fontWeight: '700', color: colors.text },
});
