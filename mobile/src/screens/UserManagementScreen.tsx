import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '../components/Buttons';
import { colors, radius, textStyles } from '../theme';
import { useApp } from '../store/AppStore';
import { createUser, listUsers, updateUser, ManagedUser } from '../data/api/client';


export function UserManagementScreen({ navigation }: { navigation: { goBack: () => void } }) {
  const { user, token, updateProfile } = useApp();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [fullName, setFullName] = useState(user?.fullName || '');
  const [password, setPassword] = useState('');
  const [newName, setNewName] = useState(''); const [newUsername, setNewUsername] = useState(''); const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === 'admin';
  async function refresh() { if (token && isAdmin) setUsers((await listUsers(token)).users); }
  useEffect(() => { void refresh(); }, [token, isAdmin]);
  async function saveProfile() { try { setBusy(true); await updateProfile(fullName.trim(), password || undefined); setPassword(''); Alert.alert('Profil', 'Informations mises à jour.'); } catch (e) { Alert.alert('Erreur', e instanceof Error ? e.message : 'Échec de la mise à jour.'); } finally { setBusy(false); } }
  async function addUser() { if (!token) return; try { await createUser(token, { username: newUsername.trim(), fullName: newName.trim(), password: newPassword, role: 'seller' }); setNewName(''); setNewUsername(''); setNewPassword(''); await refresh(); } catch (e) { Alert.alert('Erreur', e instanceof Error ? e.message : 'Création impossible.'); } }
  async function toggle(u: ManagedUser) { if (!token) return; await updateUser(token, u.id, { active: !u.active }); await refresh(); }
  return <ScrollView contentContainerStyle={styles.root}>
    <Button title="← Retour" variant="ghost" small onPress={() => navigation.goBack()} />
    <Text style={textStyles.h1}>Mon profil</Text><Text style={styles.muted}>Modifiez vos informations personnelles.</Text>
    <Text style={textStyles.label}>Nom complet</Text><TextInput style={styles.input} value={fullName} onChangeText={setFullName} />
    <Text style={textStyles.label}>Nouveau mot de passe (facultatif)</Text><TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry placeholder="8 caractères minimum" />
    <Button title={busy ? 'Enregistrement…' : 'Enregistrer mon profil'} onPress={() => void saveProfile()} disabled={busy} />
    {isAdmin ? <><Text style={[textStyles.h1, styles.section]}>Gestion des utilisateurs</Text>
      <View style={styles.card}><Text style={textStyles.h2}>Créer un utilisateur vendeur</Text><TextInput style={styles.input} placeholder="Nom complet" value={newName} onChangeText={setNewName} /><TextInput style={styles.input} placeholder="Nom d’utilisateur" value={newUsername} onChangeText={setNewUsername} autoCapitalize="none" /><TextInput style={styles.input} placeholder="Mot de passe" value={newPassword} onChangeText={setNewPassword} secureTextEntry /><Button title="Créer l’utilisateur" onPress={() => void addUser()} /></View>
      {users.map(u => <View style={styles.row} key={u.id}><View><Text style={textStyles.body}>{u.fullName}</Text><Text style={styles.muted}>@{u.username} · {u.role === 'admin' ? 'Admin' : 'Vendeur'} · {u.active ? 'Actif' : 'Désactivé'}</Text></View><Button small title={u.active ? 'Désactiver' : 'Activer'} variant={u.active ? 'danger' : 'secondary'} onPress={() => void toggle(u)} /></View>)}</> : null}
  </ScrollView>;
}
const styles = StyleSheet.create({ root: { padding: 20, gap: 8, backgroundColor: colors.background, minHeight: '100%' }, muted: { color: colors.textMuted, marginBottom: 8 }, input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 11, marginBottom: 6 }, section: { marginTop: 24 }, card: { backgroundColor: colors.surface, padding: 16, borderRadius: radius.lg, gap: 6, marginVertical: 8 }, row: { backgroundColor: colors.surface, padding: 14, borderRadius: radius.md, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 3 } });
