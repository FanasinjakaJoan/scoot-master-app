import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, textStyles } from '../theme';
import { APP_NAME } from '../lib/config';

/**
 * Filet de sécurité de rendu : une exception dans un écran afficherait sinon
 * une page vide (le comportement par défaut de React en production).
 * On montre ici un message lisible, avec « Réessayer ».
 */

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // eslint-disable-next-line no-console
    console.error(`${APP_NAME} — erreur d'affichage`, error);
  }

  private reset = (): void => {
    this.setState({ error: null });
    if (Platform.OS === 'web') {
      const location = (globalThis as { location?: { reload?: () => void } }).location;
      location?.reload?.();
    }
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={styles.wrap}>
        <View style={styles.card}>
          <Text style={styles.emoji}>⚠️</Text>
          <Text style={textStyles.h2}>Affichage impossible</Text>
          <Text style={[textStyles.caption, styles.message]}>{error.message || 'Erreur inconnue.'}</Text>
          <Pressable onPress={this.reset} style={styles.button}>
            <Text style={styles.buttonLabel}>Réessayer</Text>
          </Pressable>
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, padding: spacing.xl },
  card: {
    maxWidth: 420,
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  emoji: { fontSize: 32 },
  message: { textAlign: 'center' },
  button: {
    marginTop: spacing.xs,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  buttonLabel: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
});
