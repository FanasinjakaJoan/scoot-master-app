import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, textStyles } from '../theme';
import { Button, Row } from './Buttons';

interface Props {
  visible: boolean;
  title?: string;
  message?: string;
  confirmLabel?: string;
  onConfirm: (password: string) => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}

/**
 * Modale de confirmation par mot de passe.
 * Utilisée pour autoriser les actions sensibles nécessitant une authentification
 * (téléversement sauvegarde, gestion utilisateurs, forçage de conflit, etc.).
 * Principe « sudo » : l'utilisateur re-saisit son mot de passe pour prouver
 * son identité, même si la session est encore valide.
 */
export function PasswordConfirmModal({
  visible,
  title = 'Confirmation requise',
  message = 'Veuillez confirmer votre mot de passe pour continuer.',
  confirmLabel = 'Confirmer',
  onConfirm,
  onCancel,
  busy = false,
  error = null,
}: Props) {
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (visible) setPassword('');
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropPress} onPress={onCancel} />
        <View style={styles.card}>
          <Text style={styles.icon}>🔐</Text>
          <Text style={textStyles.h2}>{title}</Text>
          <Text style={[textStyles.caption, { marginTop: 6, lineHeight: 18 }]}>{message}</Text>

          <View style={{ marginTop: 14, width: '100%', gap: 6 }}>
            <Text style={textStyles.label}>Mot de passe</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="Votre mot de passe"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              autoFocus
              style={styles.input}
              onSubmitEditing={() => {
                if (password) onConfirm(password);
              }}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>

          <View style={{ marginTop: 16, width: '100%', gap: 8 }}>
            <Button
              title={busy ? 'Vérification…' : confirmLabel}
              onPress={() => onConfirm(password)}
              disabled={busy || !password}
            />
            <Button title="Annuler" variant="secondary" onPress={onCancel} disabled={busy} />
          </View>

          <Text style={[textStyles.caption, { marginTop: 12, fontSize: 11, textAlign: 'center' }]}>
            Cette vérification garantit que vous êtes bien le propriétaire du compte.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  backdropPress: {
    ...StyleSheet.absoluteFill,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  icon: { fontSize: 36, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.background,
  },
  error: { color: colors.danger, fontSize: 13, marginTop: 4 },
});
