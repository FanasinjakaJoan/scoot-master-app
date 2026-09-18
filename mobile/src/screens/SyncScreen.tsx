import React, { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Alert } from '../lib/alert';
import { colors, textStyles } from '../theme';
import { useApp } from '../store/AppStore';
import { pendingOperations, listConflicts } from '../data/local/repositories';
import { Screen, Card } from '../components/Screen';
import { StatusPill } from '../components/StatusPill';
import { Button, Row } from '../components/Buttons';
import { PasswordConfirmModal } from '../components/PasswordConfirmModal';
import { timeAgo } from '../lib/format';
import type { ConflictRecord } from '../types';
import type { NavigatorProp } from '../navigation/types';

const ENTITY_ICON: Record<string, string> = { bikes: '🏍️', customers: '👥', sales: '🧾' };
const ENTITY_LABEL: Record<string, string> = { bikes: 'Moto', customers: 'Client', sales: 'Vente' };
const OP_LABEL: Record<string, string> = { create: 'Création', update: 'Modification', delete: 'Suppression' };

type PendingAction =
  | { kind: 'upload' }
  | { kind: 'force'; conflict: ConflictRecord }
  | { kind: 'reauth' }
  | null;

export function SyncScreen({ navigation }: NavigatorProp<'Sync'>) {
  const app = useApp();
  const [, force] = useState(0);
  const rerender = () => force((v) => v + 1);

  const ops = pendingOperations(100);
  const conflicts = listConflicts();

  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdError, setPwdError] = useState<string | null>(null);

  async function onManualSync() {
    if (app.sync.authRequired) {
      setPendingAction({ kind: 'reauth' });
      return;
    }
    app.scheduleSync(0);
  }

  function onExport(entity: 'bikes' | 'customers' | 'sales', format: 'json' | 'csv') {
    app.shareExport(entity, format)
      .catch((e) => Alert.alert('Export', e instanceof Error ? e.message : 'Échec de l’export.'));
  }

  function onBackup() {
    app.shareFullBackup().catch((e) => Alert.alert('Sauvegarde', e instanceof Error ? e.message : 'Échec.'));
  }

  function onUploadRequest() {
    if (!app.online) {
      Alert.alert('Hors ligne', 'Le téléversement de la sauvegarde nécessite une connexion.');
      return;
    }
    setPwdError(null);
    setPendingAction({ kind: 'upload' });
  }

  async function handlePasswordConfirm(password: string) {
    if (!password) {
      setPwdError('Veuillez saisir votre mot de passe.');
      return;
    }
    setPwdBusy(true);
    setPwdError(null);
    try {
      if (pendingAction?.kind === 'upload') {
        const file = await app.uploadBackupWithPassword(password);
        setPendingAction(null);
        Alert.alert('Sauvegarde envoyée', `Stockée sur le serveur : ${file}`);
      } else if (pendingAction?.kind === 'force') {
        await app.confirmPassword(password);
        await app.resolveConflict(pendingAction.conflict.queue_id, false);
        setPendingAction(null);
        rerender();
        Alert.alert('Conflit résolu', 'Votre version a été forcée sur le serveur (validation admin).');
      } else if (pendingAction?.kind === 'reauth') {
        await app.confirmPassword(password);
        setPendingAction(null);
        Alert.alert('Session renouvelée', 'Votre session a été renouvelée. La synchronisation va reprendre.');
        app.scheduleSync(0);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Mot de passe incorrect ou erreur réseau.';
      setPwdError(msg);
    } finally {
      setPwdBusy(false);
    }
  }

  function onConflict(c: ConflictRecord, keepServer: boolean) {
    if (keepServer) {
      const title = 'Conserver la version serveur';
      Alert.alert(title,
        `Votre version locale sera remplacée par celle du serveur (${ENTITY_LABEL[c.entity]} ${c.id.slice(0, 8)}…).`,
        [
          { text: 'Annuler', style: 'cancel' },
          {
            text: 'Valider',
            onPress: () => app.resolveConflict(c.queue_id, true)
              .catch((e) => Alert.alert('Conflit', e instanceof Error ? e.message : 'Échec.'))
              .finally(rerender),
          },
        ]);
    } else {
      // Forcer nécessite confirmation par mot de passe (action sensible admin)
      setPwdError(null);
      setPendingAction({ kind: 'force', conflict: c });
    }
  }

  const modalTitle =
    pendingAction?.kind === 'upload'
      ? 'Téléverser la sauvegarde'
      : pendingAction?.kind === 'force'
        ? 'Forcer ma version (admin)'
        : pendingAction?.kind === 'reauth'
          ? 'Session expirée'
          : 'Confirmation requise';

  const modalMessage =
    pendingAction?.kind === 'upload'
      ? 'Cette action téléverse vos données locales vers le serveur. Veuillez confirmer votre mot de passe pour autoriser le téléversement.'
      : pendingAction?.kind === 'force'
        ? `Vous allez imposer votre version locale pour ${ENTITY_LABEL[pendingAction.conflict.entity]} ${pendingAction.conflict.id.slice(0, 8)}… sur le serveur. Cette action sensible nécessite une confirmation par mot de passe.`
        : pendingAction?.kind === 'reauth'
          ? 'Votre session a expiré ou n’a pas pu être renouvelée automatiquement. Confirmez votre mot de passe pour renouveler la session et reprendre la synchronisation. Vos données locales sont conservées.'
          : 'Veuillez confirmer votre mot de passe pour continuer.';

  return (
    <Screen
      title="Synchronisation"
      subtitle="Offline-first : tout est enregistré localement, puis transmis."
      onBack={() => navigation.goBack()}
    >
      <StatusPill
        online={app.online}
        syncing={app.sync.syncing}
        lastSyncAt={app.sync.lastSyncAt}
        pending={app.sync.pendingCount}
        conflicts={app.sync.conflictCount}
        failed={app.sync.failedCount}
        authRequired={app.sync.authRequired}
      />
      {app.sync.authRequired ? (
        <Card style={{ borderColor: colors.warning + '88' }}>
          <Text style={[textStyles.caption, { color: colors.warning, fontWeight: '700' }]}>
            🔐 Session à renouveler — confirmation requise
          </Text>
          <Text style={[textStyles.caption, { marginTop: 4 }]}>
            Votre session a expiré ou n'a pas pu être renouvelée automatiquement. Vos {app.sync.pendingCount} modification(s)
            en attente restent conservées localement. Touchez « Renouveler la session » et confirmez votre mot de passe pour
            reprendre la synchronisation et autoriser les téléversements.
          </Text>
          <View style={{ marginTop: 10 }}>
            <Button small title="🔐 Renouveler la session (mot de passe)" onPress={() => { setPwdError(null); setPendingAction({ kind: 'reauth' }); }} />
          </View>
        </Card>
      ) : null}
      {app.sync.lastError ? (
        <Card style={{ borderColor: colors.danger + '55' }}>
          <Text style={[textStyles.caption, { color: colors.danger }]}>Dernière erreur : {app.sync.lastError}</Text>
        </Card>
      ) : null}

      <Button title={app.sync.syncing ? 'Synchronisation…' : 'Synchroniser maintenant'} onPress={onManualSync}
        disabled={app.sync.syncing || !app.online} variant={app.online ? 'primary' : 'secondary'} />
      {app.sync.authRequired ? (
        <Text style={textStyles.caption}>
          La synchronisation reprendra automatiquement après confirmation de votre mot de passe.
        </Text>
      ) : null}

      {/* ---- Conflits ---- */}
      <Text style={[textStyles.h2, styles.section]}>Conflits ({conflicts.length})</Text>
      {conflicts.length === 0 ? (
        <Card>
          <Text style={textStyles.caption}>Aucun conflit : toutes les versions sont d’accord. 🎉</Text>
        </Card>
      ) : (
        conflicts.map((c) => {
          const server = c.server_data as { price?: number; first_name?: string; last_name?: string; sale_number?: string; updated_at?: string };
          const detail =
            c.entity === 'bikes'
              ? `Prix serveur : ${server.price != null ? server.price + ' Ar' : '—'} · modif. ${timeAgo(server.updated_at || c.detected_at)}`
              : c.entity === 'customers'
                ? `Serveur : ${server.first_name || ''} ${server.last_name || ''} · modif. ${timeAgo(server.updated_at || c.detected_at)}`
                : `Serveur : ${server.sale_number || c.id.slice(0, 8)} · modif. ${timeAgo(server.updated_at || c.detected_at)}`;
          return (
            <Card key={c.queue_id} style={{ borderColor: colors.warning + '66' }}>
              <Row gap={8}>
                <Text style={styles.conflictIcon}>⚠️</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.conflictTitle}>
                    {ENTITY_ICON[c.entity]} {ENTITY_LABEL[c.entity]} — {c.id.slice(0, 8)}…
                  </Text>
                  <Text style={textStyles.caption}>{detail}</Text>
                </View>
              </Row>
              <View style={styles.conflictActions}>
                <Button small variant="secondary" title="Garder le serveur" onPress={() => onConflict(c, true)} />
                <Button
                  small
                  title="Forcer la mienne 🔐"
                  variant="danger"
                  disabled={app.user?.role !== 'admin'}
                  onPress={() => onConflict(c, false)}
                />
              </View>
              {app.user?.role !== 'admin' ? (
                <Text style={textStyles.caption}>ⓘ Forcer est réservé aux administrateurs (validation) et nécessite confirmation par mot de passe.</Text>
              ) : (
                <Text style={textStyles.caption}>ⓘ Cette action sensible nécessite une confirmation par mot de passe.</Text>
              )}
            </Card>
          );
        })
      )}

      {/* ---- File d'attente ---- */}
      <Text style={[textStyles.h2, styles.section]}>Modifications en attente ({ops.length})</Text>
      {ops.length === 0 ? (
        <Card>
          <Text style={textStyles.caption}>File vide — rien à synchroniser.</Text>
        </Card>
      ) : (
        <FlatList
          data={ops}
          keyExtractor={(o) => String(o.id)}
          style={styles.queueList}
          renderItem={({ item }) => (
            <Card style={item.status === 'failed' ? { borderColor: colors.danger + '66' } : undefined}>
              <Row gap={8}>
                <Text>{ENTITY_ICON[item.entity] || '📦'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.queueTitle}>
                    {OP_LABEL[item.op]} — {ENTITY_LABEL[item.entity]} {item.entity_id.slice(0, 8)}…
                  </Text>
                  <Text style={textStyles.caption}>
                    {timeAgo(item.client_ts)}
                    {item.status === 'conflict' ? ' · conflit' : item.status === 'failed' ? ` · en échec (${item.attempts} tentatives)` : ''}
                    {item.last_error ? ` · ${item.last_error}` : ''}
                  </Text>
                </View>
                {item.status === 'failed' ? (
                  <Button small variant="secondary" title="Retenter" onPress={() => { app.retryFailed(item.id); rerender(); }} />
                ) : null}
              </Row>
            </Card>
          )}
        />
      )}

      {/* ---- Exports / sauvegarde ---- */}
      <Text style={[textStyles.h2, styles.section]}>Exporter &amp; sauvegarder</Text>
      <Card>
        <Text style={[textStyles.label, { marginBottom: 8 }]}>CATALOGUE MOTOS</Text>
        <Row gap={8}>
          <Button small variant="secondary" title="JSON" onPress={() => onExport('bikes', 'json')} />
          <Button small variant="secondary" title="CSV" onPress={() => onExport('bikes', 'csv')} />
        </Row>
        <Text style={[textStyles.label, { marginTop: 14, marginBottom: 8 }]}>CLIENTS</Text>
        <Row gap={8}>
          <Button small variant="secondary" title="JSON" onPress={() => onExport('customers', 'json')} />
          <Button small variant="secondary" title="CSV" onPress={() => onExport('customers', 'csv')} />
        </Row>
        <Text style={[textStyles.label, { marginTop: 14, marginBottom: 8 }]}>VENTES</Text>
        <Row gap={8}>
          <Button small variant="secondary" title="JSON" onPress={() => onExport('sales', 'json')} />
          <Button small variant="secondary" title="CSV" onPress={() => onExport('sales', 'csv')} />
        </Row>
      </Card>
      <Button title="💾 Sauvegarde complète (JSON)" variant="secondary" onPress={onBackup} />
      <Button
        title="☁️ Téléverser la sauvegarde sur le serveur 🔐"
        variant="secondary"
        disabled={!app.online}
        onPress={onUploadRequest}
      />
      {!app.online ? (
        <Text style={textStyles.caption}>Téléversement indisponible hors ligne — la sauvegarde locale reste possible.</Text>
      ) : (
        <Text style={textStyles.caption}>Le téléversement nécessite une confirmation par mot de passe pour sécuriser vos données.</Text>
      )}

      <Text style={[textStyles.caption, styles.foot]}>
        Stratégie de résolution : la modification la plus récente l’emporte (Last-Write-Wins) ;
        en cas de doute, un administrateur peut forcer sa version (validation administrative) après confirmation par mot de passe.
      </Text>

      <PasswordConfirmModal
        visible={!!pendingAction}
        title={modalTitle}
        message={modalMessage}
        confirmLabel={pendingAction?.kind === 'upload' ? 'Téléverser' : pendingAction?.kind === 'force' ? 'Forcer' : 'Renouveler'}
        onConfirm={handlePasswordConfirm}
        onCancel={() => { setPendingAction(null); setPwdError(null); }}
        busy={pwdBusy}
        error={pwdError}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 4, marginTop: 6 },
  queueList: { gap: 8 },
  queueTitle: { fontSize: 13, fontWeight: '700', color: colors.text },
  conflictIcon: { fontSize: 18 },
  conflictTitle: { fontSize: 13, fontWeight: '700', color: colors.text },
  conflictActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  foot: { marginTop: 10, lineHeight: 18 },
});
