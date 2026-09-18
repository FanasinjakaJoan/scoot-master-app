import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Alert } from '../lib/alert';
import { colors, radius, textStyles } from '../theme';
import { Button } from '../components/Buttons';
import { useApp } from '../store/AppStore';
import { createUser, listUsers, updateUser, ApiError, ManagedUser } from '../data/api/client';

/**
 * Gestion des utilisateurs & profil personnel.
 * - Tout utilisateur authentifié : consultation et modification de SON profil
 *   (PATCH /api/users/profile — auto-service).
 * - Administrateur : liste complète des comptes, création, édition du rôle et
 *   activation/désactivation (GET/POST/PATCH|PUT /api/users[/:id]).
 * Chaque erreur API (401 session expirée, 403 droits insuffisants, réseau…)
 * est affichée explicitement ; une session expirée redirige vers la connexion
 * sans perdre la moindre donnée locale.
 */

export function UserManagementScreen({ navigation }: { navigation: { goBack: () => void } }) {
  const { user, token, online, updateProfile, sessionExpired } = useApp();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [fullName, setFullName] = useState(user?.fullName || '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState(''); const [newUsername, setNewUsername] = useState(''); const [newPassword, setNewPassword] = useState('');
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const isAdmin = user?.role === 'admin';

  /** Messages d'erreur lisibles ; true si la session doit être ré-authentifiée. */
  function describeError(e: unknown): { message: string; auth: boolean } {
    if (e instanceof ApiError) {
      if (e.status === 0) return { message: 'Aucune connexion réseau — réessayez une fois en ligne.', auth: false };
      if (e.status === 401) return { message: 'Session expirée — reconnectez-vous.', auth: true };
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
      if (d.auth) await sessionExpired('Votre session a expiré. Reconnectez-vous pour retrouver la gestion des utilisateurs.');
    } finally {
      setLoadingUsers(false);
    }
  }, [token, isAdmin, sessionExpired]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function saveProfile() {
    if (!fullName.trim()) { Alert.alert('Profil', 'Le nom complet ne peut pas être vide.'); return; }
    try {
      setBusy(true);
      await updateProfile(fullName.trim(), password || undefined);
      setPassword('');
      Alert.alert('Profil', 'Informations mises à jour.');
      if (isAdmin) await refresh(); // le nom affiché dans la liste est mis à jour
    } catch (e) {
      const d = describeError(e);
      Alert.alert('Erreur', d.message);
      if (d.auth) await sessionExpired();
    } finally {
      setBusy(false);
    }
  }

  async function addUser() {
    if (!token) return;
    if (!newName.trim() || !newUsername.trim() || newPassword.length < 8) {
      Alert.alert('Créer un utilisateur', 'Nom complet, identifiant et mot de passe de 8 caractères minimum requis.');
      return;
    }
    try {
      setRowBusyId('new');
      await createUser(token, { username: newUsername.trim(), fullName: newName.trim(), password: newPassword, role: 'seller' });
      setNewName(''); setNewUsername(''); setNewPassword('');
      Alert.alert('Utilisateur créé', 'Le compte vendeur est actif : il peut se connecter.');
      await refresh();
    } catch (e) {
      const d = describeError(e);
      Alert.alert('Création impossible', d.message);
      if (d.auth) await sessionExpired();
    } finally {
      setRowBusyId(null);
    }
  }

  async function toggle(u: ManagedUser) {
    if (!token) return;
    try {
      setRowBusyId(u.id);
      await updateUser(token, u.id, { active: !u.active });
      await refresh();
    } catch (e) {
      const d = describeError(e);
      Alert.alert('Modification impossible', d.message);
      if (d.auth) await sessionExpired();
    } finally {
      setRowBusyId(null);
    }
  }

  async function changeRole(u: ManagedUser) {
    if (!token) return;
    const target = u.role === 'admin' ? 'seller' : 'admin';
    try {
      setRowBusyId(u.id);
      await updateUser(token, u.id, { role: target });
      await refresh();
    } catch (e) {
      const d = describeError(e);
      Alert.alert('Modification du rôle impossible', d.message);
      if (d.auth) await sessionExpired();
    } finally {
      setRowBusyId(null);
    }
  }

  return <ScrollView contentContainerStyle={styles.root}>
    <Button title="← Retour" variant="ghost" small onPress={() => navigation.goBack()} />
    <Text style={textStyles.h1}>Mon profil</Text><Text style={styles.muted}>Modifiez vos informations personnelles.</Text>
    <Text style={textStyles.label}>Nom complet</Text><TextInput style={styles.input} value={fullName} onChangeText={setFullName} />
    <Text style={textStyles.label}>Nouveau mot de passe (facultatif)</Text><TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry placeholder="8 caractères minimum" />
    <Button title={busy ? 'Enregistrement…' : 'Enregistrer mon profil'} onPress={() => void saveProfile()} disabled={busy || !online} />
    {!online ? <Text style={styles.muted}>Hors ligne : la modification du profil nécessite une connexion (vos données métier restent enregistrées localement).</Text> : null}
    {isAdmin ? <><Text style={[textStyles.h1, styles.section]}>Gestion des utilisateurs</Text>
      <View style={styles.card}><Text style={textStyles.h2}>Créer un utilisateur vendeur</Text><TextInput style={styles.input} placeholder="Nom complet" value={newName} onChangeText={setNewName} /><TextInput style={styles.input} placeholder="Nom d’utilisateur" value={newUsername} onChangeText={setNewUsername} autoCapitalize="none" /><TextInput style={styles.input} placeholder="Mot de passe (8 car. min.)" value={newPassword} onChangeText={setNewPassword} secureTextEntry /><Button title={rowBusyId === 'new' ? 'Création…' : 'Créer l’utilisateur'} onPress={() => void addUser()} disabled={rowBusyId === 'new' || !online} /></View>
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
              <Button small variant="secondary" title={u.role === 'admin' ? '→ Vendeur' : '→ Admin'} disabled={rowBusyId === u.id || !online} onPress={() => void changeRole(u)} />
            ) : null}
            <Button small title={u.active ? 'Désactiver' : 'Activer'} variant={u.active ? 'danger' : 'secondary'} disabled={rowBusyId === u.id || !online} onPress={() => void toggle(u)} />
          </View>
        </View>
      ))}
      {!loadingUsers && !listError && users.length === 0 ? <Text style={styles.muted}>Aucun utilisateur affiché — touchez « Réessayer » une fois en ligne.</Text> : null}
    </> : null}
  </ScrollView>;
}
const styles = StyleSheet.create({ root: { padding: 20, gap: 8, backgroundColor: colors.background, minHeight: '100%' }, muted: { color: colors.textMuted, marginBottom: 8 }, input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 11, marginBottom: 6 }, section: { marginTop: 24 }, card: { backgroundColor: colors.surface, padding: 16, borderRadius: radius.lg, gap: 6, marginVertical: 8 }, row: { backgroundColor: colors.surface, padding: 14, borderRadius: radius.md, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 3, gap: 8 }, actions: { flexDirection: 'row', gap: 6, alignItems: 'center' } });
