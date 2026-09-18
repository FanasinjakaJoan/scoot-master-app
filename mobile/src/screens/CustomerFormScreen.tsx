import React, { useState } from 'react';
import { StyleSheet } from 'react-native';
import { Alert } from '../lib/alert';
import { textStyles } from '../theme';
import { useApp, newEntityId } from '../store/AppStore';
import { customerById } from '../data/local/repositories';
import { Screen, Card } from '../components/Screen';
import { Field } from '../components/FormField';
import { Button } from '../components/Buttons';
import type { NavigatorProp } from '../navigation/types';

export function CustomerFormScreen({ navigation, route }: NavigatorProp<'CustomerForm'>) {
  const { saveCustomer } = useApp();
  const editId = route.params?.id;
  const existing = editId ? customerById(editId) : null;

  const [firstName, setFirstName] = useState(existing?.first_name || '');
  const [lastName, setLastName] = useState(existing?.last_name || '');
  const [phone, setPhone] = useState(existing?.phone || '');
  const [email, setEmail] = useState(existing?.email || '');
  const [address, setAddress] = useState(existing?.address || '');
  const [notes, setNotes] = useState(existing?.notes || '');

  function submit() {
    if (!firstName.trim() || !lastName.trim() || !phone.trim()) {
      Alert.alert('Champs requis', 'Prénom, nom et téléphone sont obligatoires.');
      return;
    }
    saveCustomer({
      id: existing?.id || newEntityId(),
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      phone: phone.trim(),
      email: email.trim() || null,
      address: address.trim() || null,
      notes: notes.trim() || null,
    });
    navigation.goBack();
  }

  return (
    <Screen
      title={existing ? 'Modifier le client' : 'Nouveau client'}
      subtitle="Enregistrement local immédiat, synchronisé ensuite."
      onBack={() => navigation.goBack()}
    >
      <Card>
        <Field label="Prénom *" value={firstName} onChangeText={setFirstName} placeholder="Rija" />
        <Field label="Nom *" value={lastName} onChangeText={setLastName} placeholder="Ando" />
        <Field label="Téléphone *" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+261 34 00 000 00" />
        <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="client@example.mg" />
        <Field label="Adresse" value={address} onChangeText={setAddress} placeholder="Antananarivo, Analakely" />
        <Field label="Notes" value={notes} onChangeText={setNotes} multiline placeholder="Préférences, remises…" />
      </Card>
      <Button title={existing ? 'Enregistrer' : 'Ajouter le client'} onPress={submit} />
    </Screen>
  );
}
