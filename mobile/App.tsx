import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ErrorBoundary } from './src/components/ErrorBoundary';
import { initLocalDb } from './src/data/local/db';
import { APP_NAME } from './src/lib/config';
import { setupInstallPrompt } from './src/lib/installApp';
import { RootNavigator } from './src/navigation/RootNavigator';
import { AppProvider } from './src/store/AppStore';
import { colors, radius, spacing, textStyles } from './src/theme';

/**
 * Scoot Master — application mobile offline-first
 * (catalogue motos 4T, ventes, clients, synchronisation avec résolution de conflits).
 *
 * L'accès à la base locale est synchrone partout (repositories, moteur de
 * synchronisation) : le moteur SQLite web, lui, se charge de façon asynchrone.
 * On affiche donc un écran de démarrage le temps de l'initialisation — et un
 * message d'action en cas d'échec, au lieu d'une page vide.
 */

type Phase = { status: 'booting' } | { status: 'ready' } | { status: 'failed'; message: string };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ status: 'booting' });

  const boot = useCallback(() => {
    setPhase({ status: 'booting' });
    initLocalDb()
      .then(() => setPhase({ status: 'ready' }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Erreur inconnue au chargement de la base locale.';
        setPhase({ status: 'failed', message });
      });
  }, []);

  useEffect(boot, [boot]);

  // Navigateur uniquement (non-événement ailleurs) : déclare le manifeste web,
  // enregistre le service worker et capte l'invite d'installation — c'est ce qui
  // alimente le raccourci « Installer l'application » (mobile et bureau).
  useEffect(() => {
    setupInstallPrompt();
  }, []);

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        {phase.status === 'ready' ? (
          <AppProvider>
            <RootNavigator />
          </AppProvider>
        ) : (
          <BootScreen phase={phase} onRetry={boot} />
        )}
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

function BootScreen({ phase, onRetry }: { phase: Phase; onRetry: () => void }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Text style={styles.logo}>🏍️</Text>
        <Text style={textStyles.h2}>{APP_NAME}</Text>
        {phase.status === 'failed' ? (
          <>
            <Text style={styles.message}>Initialisation impossible : {phase.message}</Text>
            <Pressable onPress={onRetry} style={styles.button}>
              <Text style={styles.buttonLabel}>Réessayer</Text>
            </Pressable>
          </>
        ) : (
          <>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.message}>Préparation de la base locale…</Text>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: spacing.xl,
  },
  card: {
    maxWidth: 420,
    width: '100%',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
  },
  logo: { fontSize: 40 },
  message: { ...textStyles.caption, textAlign: 'center' },
  button: {
    marginTop: spacing.xs,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  buttonLabel: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
});
