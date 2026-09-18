import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme';
import { timeAgo } from '../lib/format';

/**
 * Indicateur de statut réseau + synchronisation (exigence UI/UX).
 * - En ligne / Hors ligne
 * - Données à jour / X modifications en attente / Y conflits
 */
export function StatusPill({
  online, syncing, lastSyncAt, pending, conflicts, failed, authRequired, onPress,
}: {
  online: boolean;
  syncing: boolean;
  lastSyncAt: string | null;
  pending: number;
  conflicts: number;
  failed: number;
  /** true : session à renouveler — transmission suspendue, données locales conservées. */
  authRequired?: boolean;
  onPress?: () => void;
}) {
  const waiting = pending + conflicts + failed;
  const line2 = authRequired
    ? 'Réauthentification requise — données conservées'
    : syncing
      ? 'Synchronisation…'
      : conflicts > 0
        ? `${conflicts} conflit${conflicts > 1 ? 's' : ''} à résoudre`
        : waiting > 0
          ? `${waiting} modification${waiting > 1 ? 's' : ''} en attente`
          : online
            ? 'Données à jour'
            : 'Hors ligne — enregistrement local';

  return (
    <Pressable onPress={onPress} style={styles.wrap}>
      <View style={[styles.dot, { backgroundColor: authRequired ? colors.warning : online ? colors.success : colors.textMuted }]} />
      <View style={styles.col}>
        <Text style={styles.state}>{online ? 'En ligne' : 'Hors ligne'}</Text>
        <Text style={[styles.sub, conflicts > 0 || authRequired ? { color: colors.warning } : null]}>
          {syncing && !authRequired ? line2 : `${line2}${lastSyncAt ? ' · ' + timeAgo(lastSyncAt) : ''}`}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  col: { flex: 1 },
  state: { fontSize: 13, fontWeight: '700', color: colors.text },
  sub: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
});
