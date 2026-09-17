import React, { useEffect, useState } from 'react';
import { Alert, Image, StyleSheet, Text, View } from 'react-native';
import { colors, textStyles } from '../theme';
import { useApp } from '../store/AppStore';
import { bikeById, listSales, listBikes } from '../data/local/repositories';
import { Screen, Card } from '../components/Screen';
import { Badge, BIKE_BADGES } from '../components/Badge';
import { Button, Row } from '../components/Buttons';
import { EmptyState } from '../components/EmptyState';
import { formatKm, formatMoney, timeAgo } from '../lib/format';
import { STATE_LABELS } from '../types';
import type { NavigatorProp } from '../navigation/types';

export function BikeDetailScreen({ navigation, route }: NavigatorProp<'BikeDetail'>) {
  const { dataVersion, patchBike, deleteBike, user } = useApp();
  const id = route.params.id;
  const [bike, setBike] = useState(bikeById(id));
  const [sales, setSales] = useState(() => listSales({ limit: 100 }));

  useEffect(() => {
    setBike(bikeById(id));
    setSales(listSales({ limit: 100 }));
  }, [id, dataVersion]);

  if (!bike) {
    return (
      <Screen title="Moto" onBack={() => navigation.goBack()}>
        <EmptyState icon="❓" title="Moto introuvable" hint="Elle a peut-être été supprimée." />
      </Screen>
    );
  }

  const badge = BIKE_BADGES[bike.status] || BIKE_BADGES.available;
  const relatedSales = sales.filter((s) => (s.items || []).some((it) => it.bike_id === id));

  const confirmDelete = () => {
    Alert.alert('Supprimer cette moto ?', `${bike.brand} ${bike.model} sera supprimée (suppression logique, synchronisée).`, [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Supprimer', style: 'destructive', onPress: () => { deleteBike(id); navigation.goBack(); } },
    ]);
  };

  const changeStatus = (next: string) => {
    if (next === bike.status) return;
    patchBike(id, { status: next as never });
  };

  return (
    <Screen
      title={`${bike.brand} ${bike.model}`}
      subtitle={`Mis à jour ${timeAgo(bike.updated_at)}`}
      onBack={() => navigation.goBack()}
    >
      {bike.photos.length > 0 ? (
        <View style={styles.photos}>
          {bike.photos.map((p, i) => (
            <Image key={i} source={{ uri: p }} style={styles.photo} resizeMode="cover" />
          ))}
        </View>
      ) : null}

      <Card>
        <Row>
          <Badge fg={badge.fg} bg={badge.bg}>{badge.label}</Badge>
          <Text style={[textStyles.caption, styles.idText]}>N° série : {bike.serial_number || '—'}</Text>
        </Row>
        <Text style={[textStyles.body, styles.desc]}>{bike.description || 'Aucune description.'}</Text>
      </Card>

      <Card>
        <View style={styles.specGrid}>
          <Spec label="Année" value={bike.year ? String(bike.year) : '—'} />
          <Spec label="Kilométrage" value={formatKm(bike.mileage_km)} />
          <Spec label="Cylindrée" value={bike.engine_cc ? `${bike.engine_cc} cc` : '—'} />
          <Spec label="Couleur" value={bike.color || '—'} />
          <Spec label="État mécanique" value={`${bike.mechanical_state}/5 · ${STATE_LABELS[bike.mechanical_state] || ''}`} />
          <Spec label="État esthétique" value={`${bike.aesthetic_state}/5 · ${STATE_LABELS[bike.aesthetic_state] || ''}`} />
          <Spec label="Magasin" value={bike.warehouse || '—'} />
          <Spec label="Prix" value={formatMoney(bike.price, bike.currency)} strong />
        </View>
      </Card>

      <Card>
        <Text style={[textStyles.h2, styles.sectionTitle]}>Changer le statut</Text>
        <Row gap={6}>
          {(['available', 'reserved', 'maintenance', 'sold'] as const).map((s) => (
            <Button
              key={s}
              small
              variant={s === bike.status ? 'primary' : 'secondary'}
              title={BIKE_BADGES[s].label}
              onPress={() => changeStatus(s)}
            />
          ))}
        </Row>
      </Card>

      <Card>
        <Text style={[textStyles.h2, styles.sectionTitle]}>Historique de vente</Text>
        {relatedSales.length === 0 ? (
          <Text style={textStyles.caption}>Aucune vente liée.</Text>
        ) : (
          relatedSales.map((s) => (
            <View key={s.id} style={styles.saleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.saleNum}>{s.sale_number}</Text>
                <Text style={textStyles.caption}>{s.customer ? `${s.customer.first_name} ${s.customer.last_name}` : ''} · {s.sale_date}</Text>
              </View>
              <Text style={styles.saleTotal}>{formatMoney(s.total)}</Text>
            </View>
          ))
        )}
      </Card>

      <Row gap={10}>
        <Button title="Modifier" variant="secondary" onPress={() => navigation.navigate('BikeForm', { id: bike.id })} />
        {user?.role === 'admin' ? (
          <Button title="Supprimer" variant="danger" onPress={confirmDelete} />
        ) : null}
      </Row>
    </Screen>
  );
}

function Spec({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.spec}>
      <Text style={textStyles.caption}>{label}</Text>
      <Text style={[textStyles.body, strong && { color: colors.primary, fontWeight: '800', fontSize: 17 }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  photos: { flexDirection: 'row', gap: 8 },
  photo: { width: 84, height: 84, borderRadius: 10, backgroundColor: colors.border },
  idText: { flex: 1, textAlign: 'right' },
  desc: { marginTop: 8 },
  specGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  spec: { width: '48%' },
  sectionTitle: { marginBottom: 10 },
  saleRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: colors.border, gap: 8,
  },
  saleNum: { fontSize: 14, fontWeight: '700', color: colors.text },
  saleTotal: { fontSize: 14, fontWeight: '800', color: colors.primary },
});
