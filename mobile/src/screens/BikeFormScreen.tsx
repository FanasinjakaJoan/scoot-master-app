import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { colors, textStyles } from '../theme';
import { useApp, newEntityId } from '../store/AppStore';
import { bikeById, availableBrands } from '../data/local/repositories';
import { Screen, Card } from '../components/Screen';
import { Field, Segmented } from '../components/FormField';
import { Button } from '../components/Buttons';
import { BIKE_STATUSES } from '../types';
import type { Bike, BikeStatus } from '../types';
import type { NavigatorProp } from '../navigation/types';

const BRANDS = ['Yamaha', 'Honda', 'Suzuki', 'Kawasaki', 'Peugeot', 'Vespa', 'Derbi', 'SYM', 'Aprilia', 'KTM', 'Autre'];

export function BikeFormScreen({ navigation, route }: NavigatorProp<'BikeForm'>) {
  const { saveBike, user } = useApp();
  const editId = route.params?.id;
  const existing = editId ? bikeById(editId) : null;

  const [brand, setBrand] = useState(existing?.brand || '');
  const [model, setModel] = useState(existing?.model || '');
  const [year, setYear] = useState(existing?.year ? String(existing.year) : '');
  const [mileage, setMileage] = useState(existing ? String(existing.mileage_km) : '');
  const [engine, setEngine] = useState(existing?.engine_cc ? String(existing.engine_cc) : '');
  const [color, setColor] = useState(existing?.color || '');
  const [serial, setSerial] = useState(existing?.serial_number || '');
  const [price, setPrice] = useState(existing ? String(existing.price) : '');
  const [mech, setMech] = useState(String(existing?.mechanical_state ?? 3));
  const [aesth, setAesth] = useState(String(existing?.aesthetic_state ?? 3));
  const [status, setStatus] = useState<BikeStatus>(existing?.status || 'available');
  const [description, setDescription] = useState(existing?.description || '');
  const [warehouse, setWarehouse] = useState(existing?.warehouse || '');
  const [photos, setPhotos] = useState<string[]>(existing?.photos || []);
  const [busy, setBusy] = useState(false);

  function numOrUndef(v: string): number | null {
    if (v.trim() === '') return null;
    const n = Number(v.replace(/[^\d]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  async function pickPhoto() {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission', 'Autorisez l’accès à la galerie pour ajouter des photos.');
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'] as never,
        quality: 0.7,
        allowsMultipleSelection: true,
      });
      if (!res.canceled && res.assets) {
        setPhotos((p) => [...p, ...res.assets.map((a) => a.uri)]);
      }
    } catch (e) {
      Alert.alert('Photos', e instanceof Error ? e.message : 'Impossible d’ouvrir la galerie.');
    }
  }

  function submit() {
    if (!brand.trim() || !model.trim()) {
      Alert.alert('Champs requis', 'La marque et le modèle sont obligatoires.');
      return;
    }
    if (!price.trim() || Number(price) < 0) {
      Alert.alert('Prix invalide', 'Saisissez un prix positif.');
      return;
    }
    setBusy(true);
    const payload: Partial<Bike> & { id: string } = {
      id: existing?.id || newEntityId(),
      brand: brand.trim(),
      model: model.trim(),
      year: numOrUndef(year),
      mileage_km: numOrUndef(mileage) ?? 0,
      engine_cc: numOrUndef(engine),
      color: color.trim() || null,
      serial_number: serial.trim() || null,
      price: Number(price),
      currency: existing?.currency || 'MGA',
      mechanical_state: Number(mech),
      aesthetic_state: Number(aesth),
      status,
      description: description.trim() || null,
      warehouse: warehouse.trim() || null,
      photos,
    };
    saveBike(payload);
    navigation.goBack();
  }

  return (
    <Screen
      title={existing ? 'Modifier la moto' : 'Nouvelle moto 4T'}
      subtitle={existing ? `${existing.brand} ${existing.model}` : 'L’enregistrement fonctionne hors ligne ; synchro automatique ensuite.'}
      onBack={() => navigation.goBack()}
    >
      <Card>
        <Field label="Marque *" value={brand} onChangeText={setBrand} placeholder="ex. Yamaha" />
        <Field label="Modèle *" value={model} onChangeText={setModel} placeholder="ex. XT 125 Z" />
        <View style={styles.row}>
          <View style={styles.half}>
            <Field label="Année" value={year} onChangeText={setYear} keyboardType="numeric" placeholder="2021" />
          </View>
          <View style={styles.half}>
            <Field label="Kilométrage (km)" value={mileage} onChangeText={setMileage} keyboardType="numeric" placeholder="12000" />
          </View>
        </View>
        <View style={styles.row}>
          <View style={styles.half}>
            <Field label="Cylindrée (cc)" value={engine} onChangeText={setEngine} keyboardType="numeric" placeholder="125" />
          </View>
          <View style={styles.half}>
            <Field label="Couleur" value={color} onChangeText={setColor} placeholder="Noir" />
          </View>
        </View>
        <Field label="N° de série" value={serial} onChangeText={setSerial} placeholder="YAM-2021-48211" />
        <Field label="Prix (Ariary) *" value={price} onChangeText={setPrice} keyboardType="numeric" placeholder="2500000" />
      </Card>

      <Card>
        <Segmented
          label="État mécanique"
          value={mech}
          options={['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v + '/5' }))}
          onChange={setMech}
        />
        <Segmented
          label="État esthétique"
          value={aesth}
          options={['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v + '/5' }))}
          onChange={setAesth}
        />
        <Segmented
          label="Statut"
          value={status}
          options={BIKE_STATUSES.map((s) => ({ value: s.value, label: s.label }))}
          onChange={(v) => setStatus(v)}
        />
      </Card>

      <Card>
        <Field label="Description" value={description} onChangeText={setDescription} multiline placeholder="Entretien, papiers, options…" />
        <Field label="Magasin / lieu" value={warehouse} onChangeText={setWarehouse} placeholder="Magasin Antananarivo" />
      </Card>

      <Card>
        <View style={styles.photoHeader}>
          <Text style={textStyles.h2}>Photos ({photos.length})</Text>
          <Button small title="＋ Ajouter" variant="secondary" onPress={pickPhoto} />
        </View>
        {photos.length > 0 ? (
          <View style={styles.photoGrid}>
            {photos.map((p, i) => (
              <View key={i} style={styles.photoWrap}>
                <Text
                  onPress={() => setPhotos((ph) => ph.filter((_, j) => j !== i))}
                  style={styles.photoX}
                >
                  ✕
                </Text>
                <Text style={styles.photoUri} numberOfLines={2}>{p}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={textStyles.caption}>Aucune photo (facultatif).</Text>
        )}
      </Card>

      <Button title={existing ? 'Enregistrer les modifications' : 'Ajouter au catalogue'} onPress={submit} disabled={busy} />
      {user?.role !== 'admin' ? (
        <Text style={textStyles.caption}>Note : la suppression est réservée aux administrateurs.</Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  photoHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  photoGrid: { gap: 8 },
  photoWrap: {
    backgroundColor: colors.background, borderRadius: 8, padding: 8,
    borderWidth: 1, borderColor: colors.border, position: 'relative',
  },
  photoX: {
    position: 'absolute', top: 4, right: 8, color: colors.danger,
    fontWeight: '700', fontSize: 14, padding: 4,
  },
  photoUri: { fontSize: 11, color: colors.textMuted },
});
