import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Alert } from '../lib/alert';
import { colors, radius, textStyles } from '../theme';
import { Button } from '../components/Buttons';
import { PasswordConfirmModal } from '../components/PasswordConfirmModal';
import { useApp } from '../store/AppStore';
import { createUser, listUsers, updateUser, ApiError, ManagedUser } from '../data/api/client';

/**
 * Gestion des utilisateurs & profil personnel avec confirmation par mot de passe.
 * - Toutes les actions sensibles (création utilisateur, activation/désactivation,
 *   changement de rôle, modification profil) nécessitent une confirmation par
 *   mot de passe (principe sudo).
 * - La session expirée n'est plus bloquante : l'utilisateur confirme son mot
 *   de passe pour renouveler la session et continuer.
 */

type PendingAction =
  | { kind: 'saveProfile'; fullName: string; newPassword?: string }
  | { kind: 'addUser'; fullName: string; username: string; password: string }
  | { kind: 'toggle'; user: ManagedUser }
  | { kind: 'changeRole'; user: ManagedUser }
  | null;

export function UserManagementScreen({ navigation }: { navigation: { goBack: () => void } }) {
  const { user, token, online, updateProfile, confirmPassword, sessionExpired } = useApp();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [fullName, setFullName] = useState(user?.fullName || '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState(''); const [newUsername, setNewUsername] = useState(''); const [newPassword, setNewPassword] = useState('');
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const isAdmin = user?.role === 'admin';

  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdError, setPwdError] = useState<string | null>(null);

  function describeError(e: unknown): { message: string; auth: boolean } {
    if (e instanceof ApiError) {
      if (e.status === 0) return { message: 'Aucune connexion réseau — réessayez une fois en ligne.', auth: false };
      if (e.status === 401) return { message: 'Session expirée ou mot de passe incorrect — confirmez votre mot de passe.', auth: true };
      if (e.status === 403) return { message: e.message || 'Droits insuffisants.', auth: false };
      return { message: e.message || `Erreur ${e.status}.`, auth: false };
    }
    return { message: e instanceof Error ? e.message : 'Opération impossible.', auth: false };
  }

  const refresh = useCallback(async () => {
    if (!token || !isAdmin) return;
    setLoadingUsers(true);
    setListError(null);
    try {
      setUsers((await listUsers(token)).users);
    } catch (e) {
      const d = describeError(e);
      setListError(d.message);
      if (d.auth) {
        // Au lieu de déconnecter, on invite à confirmer le mot de passe
        setListError(d.message + ' Touchez « Réessayer » après confirmation par mot de passe.');
      }
    } finally {
      setLoadingUsers(false);
    }
  }, [token, isAdmin]);

  useEffect(() => { void refresh(); }, [refresh]);

  // ---- Actions avec confirmation par mot de passe ----

  function requestSaveProfile() {
    if (!fullName.trim()) { Alert.alert('Profil', 'Le nom complet ne peut pas être vide.'); return; }
    setPwdError(null);
    setPendingAction({ kind: 'saveProfile', fullName: fullName.trim(), newPassword: password || undefined });
  }

  function requestAddUser() {
    if (!newName.trim() || !newUsername.trim() || newPassword.length < 8) {
      Alert.alert('Créer un utilisateur', 'Nom complet, identifiant et mot de passe de 8 caractères minimum requis.');
      return;
    }
    setPwdError(null);
    setPendingAction({ kind: 'addUser', fullName: newName.trim(), username: newUsername.trim(), password: newPassword });
  }

  function requestToggle(u: ManagedUser) {
    setPwdError(null);
    setPendingAction({ kind: 'toggle', user: u });
  }

  function requestChangeRole(u: ManagedUser) {
    setPwdError(null);
    setPendingAction({ kind: 'changeRole', user: u });
  }

  async function handlePasswordConfirm(confirmPwd: string) {
    if (!confirmPwd) {
      setPwdError('Veuillez saisir votre mot de passe pour confirmer.');
      return;
    }
    if (!token) {
      setPwdError('Aucune session active.');
      return;
    }
    setPwdBusy(true);
    setPwdError(null);
    try {
      // 1) Confirmer le mot de passe et renouveler la session
      await confirmPassword(confirmPwd);

      // 2) Exécuter l'action demandée avec le nouveau jeton frais
      // On récupère le token frais via le store (il a été persisté)
      // Mais on utilise le token courant du store qui a été mis à jour
      const freshToken = token; // après confirmPassword, le store a un nouveau token, mais on utilise la closure précédente
      // Pour éviter la stale closure, on relit via une fonction qui utilise le token actuel du backend via listUsers etc.
      // On va utiliser le token du store actuel en appelant directement les API avec le token du state qui a été mis à jour
      // Simplification : on utilise le token du store qui est maintenant frais (via re-render, mais on a la ref)
      // On refait les appels en utilisant le token du store actuel (on va chercher le token le plus récent via une variable locale)
      // Pour les besoins, on utilise le token d'origine car confirmPassword a déjà renouvelé et les prochains appels utiliseront le nouveau token via le state

      if (pendingAction?.kind === 'saveProfile') {
        setBusy(true);
        try {
          await updateProfile(pendingAction.fullName, pendingAction.newPassword);
          setPassword('');
          Alert.alert('Profil', 'Informations mises à jour après confirmation par mot de passe.');
          if (isAdmin) await refresh();
          setPendingAction(null);
        } finally {
          setBusy(false);
        }
      } else if (pendingAction?.kind === 'addUser') {
        setRowBusyId('new');
        try {
          // On utilise directement l'API avec le token courant (qui vient d'être renouvelé)
          // On récupère le token frais depuis le stockage pour être sûr
          const { secureGet } = require('../lib/secureStorage') as typeof import('../lib/secureStorage');
          const fresh = await secureGet('sm_token');
          const t = fresh || token;
          await createUser(t, { username: pendingAction.username, fullName: pendingAction.fullName, password: pendingAction.password, role: 'seller' });
          setNewName(''); setNewUsername(''); setNewPassword('');
          Alert.alert('Utilisateur créé', 'Le compte vendeur est actif après confirmation par mot de passe.');
          await refresh();
          setPendingAction(null);
        } finally {
          setRowBusyId(null);
        }
      } else if (pendingAction?.kind === 'toggle') {
        setRowBusyId(pendingAction.user.id);
        try {
          const { secureGet } = require('../lib/secureStorage') as typeof import('../lib/secureStorage');
          const fresh = await secureGet('sm_token');
          const t = fresh || token;
          await updateUser(t, pendingAction.user.id, { active: !pendingAction.user.active });
          Alert.alert('Statut modifié', `Compte ${!pendingAction.user.active ? 'activé' : 'désactivé'} après confirmation.`);
          await refresh();
          setPendingAction(null);
        } finally {
          setRowBusyId(null);
        }
      } else if (pendingAction?.kind === 'changeRole') {
        const target = pendingAction.user.role === 'admin' ? 'seller' : 'admin';
        setRowBusyId(pendingAction.user.id);
        try {
          const { secureGet } = require('../lib/secureStorage') as typeof import('../lib/secureStorage');
          const fresh = await secureGet('sm_token');
          const t = fresh || token;
          await updateUser(t, pendingAction.user.id, { role: target });
          Alert.alert('Rôle modifié', `Rôle changé en ${target} après confirmation.`);
          await refresh();
          setPendingAction(null);
        } finally {
          setRowBusyId(null);
        }
      }
    } catch (e) {
      const d = describeError(e);
      setPwdError(d.message);
    } finally {
      setPwdBusy(false);
    }
  }

  const modalTitle =
    pendingAction?.kind === 'saveProfile'
      ? 'Confirmer la modification du profil'
      : pendingAction?.kind === 'addUser'
        ? 'Confirmer la création d’utilisateur'
        : pendingAction?.kind === 'toggle'
          ? `${pendingAction.user.active ? 'Désactiver' : 'Activer'} le compte`
          : pendingAction?.kind === 'changeRole'
            ? 'Changer le rôle'
            : 'Confirmation requise';

  const modalMessage =
    pendingAction?.kind === 'saveProfile'
      ? 'Vous allez modifier votre profil. Veuillez confirmer votre mot de passe pour autoriser cette action.'
      : pendingAction?.kind === 'addUser'
        ? `Vous allez créer le compte vendeur "${pendingAction.username}". Cette action sensible nécessite une confirmation par mot de passe.`
        : pendingAction?.kind === 'toggle'
          ? `Vous allez ${pendingAction.user.active ? 'désactiver' : 'activer'} le compte @${pendingAction.user.username} (${pendingAction.user.fullName}). Confirmez votre mot de passe.`
          : pendingAction?.kind === 'changeRole'
            ? `Vous allez changer le rôle de @${pendingAction.user.username} de ${pendingAction.user.role} à ${pendingAction.user.role === 'admin' ? 'seller' : 'admin'}. Cette action sensible nécessite une confirmation.`
            : 'Veuillez confirmer votre mot de passe pour continuer.';

  return (
    <>
      <ScrollView contentContainerStyle={styles.root}>
        <Button title="← Retour" variant="ghost" small onPress={() => navigation.goBack()} />
        <Text style={textStyles.h1}>Mon profil</Text><Text style={styles.muted}>Modifiez vos informations personnelles. Toute modification nécessite une confirmation par mot de passe.</Text>
        <Text style={textStyles.label}>Nom complet</Text><TextInput style={styles.input} value={fullName} onChangeText={setFullName} />
        <Text style={textStyles.label}>Nouveau mot de passe (facultatif)</Text><TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry placeholder="8 caractères minimum" />
        <Button title={busy ? 'Enregistrement…' : 'Enregistrer mon profil 🔐'} onPress={() => void requestSaveProfile()} disabled={busy || !online} />
        {!online ? <Text style={styles.muted}>Hors ligne : la modification du profil nécessite une connexion (vos données métier restent enregistrées localement).</Text> : null}
        {isAdmin ? <>
          <Text style={[textStyles.h1, styles.section]}>Gestion des utilisateurs</Text>
          <Text style={styles.muted}>Les actions d'administration nécessitent une confirmation par mot de passe.</Text>
          <View style={styles.card}><Text style={textStyles.h2}>Créer un utilisateur vendeur</Text><TextInput style={styles.input} placeholder="Nom complet" value={newName} onChangeText={setNewName} /><TextInput style={styles.input} placeholder="Nom d’utilisateur" value={newUsername} onChangeText={setNewUsername} autoCapitalize="none" /><TextInput style={styles.input} placeholder="Mot de passe (8 car. min.)" value={newPassword} onChangeText={setNewPassword} secureTextEntry /><Button title={rowBusyId === 'new' ? 'Création…' : 'Créer l’utilisateur 🔐'} onPress={() => void requestAddUser()} disabled={rowBusyId === 'new' || !online} /></View>
          {listError ? <View style={styles.card}><Text style={[textStyles.caption, { color: colors.danger }]}>{listError}</Text><Button small variant="secondary" title="Réessayer" onPress={() => void refresh()} disabled={!online} /></View> : null}
          {loadingUsers && users.length === 0 ? <Text style={styles.muted}>Chargement de la liste…</Text> : null}
          {users.map(u => (
            <View style={styles.row} key={u.id}>
              <View style={{ flex: 1 }}>
                <Text style={textStyles.body}>{u.fullName}{u.id === user?.id ? ' (vous)' : ''}</Text>
                <Text style={styles.muted}>@{u.username} · {u.role === 'admin' ? 'Admin' : 'Vendeur'} · {u.active ? 'Actif' : 'Désactivé'}</Text>
              </View>
              <View style={styles.actions}>
                {u.id !== user?.id ? (
                  <Button small variant="secondary" title={u.role === 'admin' ? '→ Vendeur 🔐' : '→ Admin 🔐'} disabled={rowBusyId === u.id || !online} onPress={() => void requestChangeRole(u)} />
                ) : null}
                <Button small title={u.active ? 'Désactiver 🔐' : 'Activer 🔐'} variant={u.active ? 'danger' : 'secondary'} disabled={rowBusyId === u.id || !online} onPress={() => void requestToggle(u)} />
              </View>
            </View>
          ))}
          {!loadingUsers && !listError && users.length === 0 ? <Text style={styles.muted}>Aucun utilisateur affiché — touchez « Réessayer » une fois en ligne.</Text> : null}
        </> : null}
      </ScrollView>

      <PasswordConfirmModal
        visible={!!pendingAction}
        title={modalTitle}
        message={modalMessage}
        confirmLabel={
          pendingAction?.kind === 'saveProfile' ? 'Enregistrer' :
            pendingAction?.kind === 'addUser' ? 'Créer' :
              pendingAction?.kind === 'toggle' ? (pendingAction.user.active ? 'Désactiver' : 'Activer') :
                pendingAction?.kind === 'changeRole' ? 'Changer le rôle' : 'Confirmer'
        }
        onConfirm={handlePasswordConfirm}
        onCancel={() => { setPendingAction(null); setPwdError(null); }}
        busy={pwdBusy}
        error={pwdError}
      />
    </>
  );
}
const styles = StyleSheet.create({
  root: { padding: 20, gap: 8, backgroundColor: colors.background, minHeight: '100%' },
  muted: { color: colors.textMuted, marginBottom: 8, fontSize: 13 },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 11, marginBottom: 6 },
  section: { marginTop: 24 },
  card: { backgroundColor: colors.surface, padding: 16, borderRadius: radius.lg, gap: 6, marginVertical: 8, borderWidth: 1, borderColor: colors.border },
  row: { backgroundColor: colors.surface, padding: 14, borderRadius: radius.md, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 3, gap: 8, borderWidth: 1, borderColor: colors.border },
  actions: { flexDirection: 'row', gap: 6, alignItems: 'center' }
});
