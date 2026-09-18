import React, { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { Alert } from '../lib/alert';
import { APK_DOWNLOAD_URL, INSTALL_GUIDE_URL } from '../lib/config';
import { openExternal, requestInstall, useInstallPlan } from '../lib/installApp';
import { colors, radius, textStyles } from '../theme';
import { Button } from './Buttons';

/**
 * Raccourci « Installer l'application ».
 *
 * Uniquement utile côté **navigateur** (l'app native est, par définition, déjà
 * installée) : la carte propose
 *  - l'invite d'installation PWA → **APK-like sur mobile** (icône au lanceur)
 *    ou **application de bureau** sur PC ;
 *  - le téléchargement de l'**APK Android** quand aucune invite n'est disponible ;
 *  - la page `/install` (procédures détaillées, APK hébergé par le serveur web).
 */
export function InstallAppCard({ compact }: { compact?: boolean }) {
  const plan = useInstallPlan();
  const [busy, setBusy] = useState(false);

  // Natif : rien à installer, la carte n'a pas de sens.
  if (Platform.OS !== 'web') return null;

  async function onInstallPrompt() {
    setBusy(true);
    try {
      const outcome = await requestInstall();
      if (outcome === 'dismissed') {
        Alert.alert('Installation annulée', 'Relancez l’installation depuis la barre d’adresse ou le menu du navigateur.');
      } else if (outcome === 'unavailable') {
        Alert.alert('Installation indisponible', plan.hint);
      }
    } finally {
      setBusy(false);
    }
  }

  const installed = plan.installed;
  const primaryLabel = plan.actionable
    ? `⬇️ ${plan.buttonLabel}`
    : plan.showApkLink
      ? '⬇️ Télécharger l’APK Android'
      : '🧭 Guide d’installation';
  const onPrimary = plan.actionable
    ? onInstallPrompt
    : plan.showApkLink
      ? () => openExternal(APK_DOWNLOAD_URL)
      : () => openExternal(INSTALL_GUIDE_URL);
  const showApkSecondary = plan.actionable && plan.showApkLink;

  return (
    <View style={[styles.card, installed ? styles.cardInstalled : null, compact ? styles.cardCompact : null]}>
      <View style={styles.head}>
        <Text style={styles.icon}>{installed ? '✅' : '📲'}</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{plan.title}</Text>
          <Text style={textStyles.caption}>{plan.hint}</Text>
        </View>
      </View>
      {installed ? null : (
        <View style={styles.actions}>
          <Button title={busy ? 'Installation…' : primaryLabel} onPress={onPrimary} disabled={busy} small={compact} />
          {showApkSecondary ? (
            <Button
              title="📱 Télécharger l’APK"
              variant="secondary"
              small={compact}
              onPress={() => openExternal(APK_DOWNLOAD_URL)}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.border, padding: 12, gap: 10,
  },
  cardInstalled: { backgroundColor: colors.successSoft, borderColor: colors.success + '44' },
  cardCompact: { padding: 10, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  icon: { fontSize: 18, marginTop: 1 },
  title: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: 2 },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
});
