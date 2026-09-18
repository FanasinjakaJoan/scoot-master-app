import React, { useMemo, useState } from 'react';
import {
  FlatList, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { colors, textStyles } from '../theme';
import { useApp, useBikes } from '../store/AppStore';
import { BikeCard } from '../components/BikeCard';
import { EmptyState } from '../components/EmptyState';
import { Button } from '../components/Buttons';
import { BIKE_STATUSES } from '../types';
import type { NavigatorProp } from '../navigation/types';

type SortKey = 'updated_at' | 'price' | 'mileage_km' | 'brand';

export function CatalogScreen({ navigation }: NavigatorProp<'Catalog'>) {
  const { dataVersion } = useApp();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [sort, setSort] = useState<SortKey>('updated_at');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [showFilters, setShowFilters] = useState(false);

  const filter = useMemo(() => ({
    status,
    q: q.trim() || undefined,
    minPrice: minPrice ? Number(minPrice) : undefined,
    maxPrice: maxPrice ? Number(maxPrice) : undefined,
    sort, order,
  }), [status, q, minPrice, maxPrice, sort, order]);

  const bikes = useBikes(filter);

  const brands = useMemo(() => {
    // Marques issues du catalogue local (rapide, hors ligne)
    const set = new Set(bikes.map((b) => b.brand));
    return Array.from(set).sort();
  }, [bikes, dataVersion]);

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={textStyles.h1}>Catalogue</Text>
          <Button
            title="Filtres"
            small
            variant={showFilters ? 'primary' : 'secondary'}
            onPress={() => setShowFilters((v) => !v)}
          />
        </View>
        <View style={styles.searchRow}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Marque, modèle, n° série…"
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
          />
        </View>
        {showFilters ? (
          <View style={styles.filters}>
            <View style={styles.chipRow}>
              <Chip label="Tous" active={!status} onPress={() => setStatus(undefined)} />
              {BIKE_STATUSES.map((s) => (
                <Chip
                  key={s.value}
                  label={s.label}
                  active={status === s.value}
                  onPress={() => setStatus(status === s.value ? undefined : s.value)}
                />
              ))}
            </View>
            <View style={styles.priceRow}>
              <View style={styles.priceCol}>
                <Text style={textStyles.label}>Prix min (Ar)</Text>
                <TextInput value={minPrice} onChangeText={setMinPrice} keyboardType="numeric"
                  placeholder="0" placeholderTextColor={colors.textMuted} style={styles.priceInput} />
              </View>
              <View style={styles.priceCol}>
                <Text style={textStyles.label}>Prix max (Ar)</Text>
                <TextInput value={maxPrice} onChangeText={setMaxPrice} keyboardType="numeric"
                  placeholder="∞" placeholderTextColor={colors.textMuted} style={styles.priceInput} />
              </View>
              <View style={styles.priceCol}>
                <Text style={textStyles.label}>Trier par</Text>
                <View style={styles.chipRow}>
                  <Chip label="Récent" active={sort === 'updated_at'} onPress={() => setSort('updated_at')} />
                  <Chip label="Prix" active={sort === 'price'} onPress={() => setSort('price')} />
                  <Chip label="Km" active={sort === 'mileage_km'} onPress={() => setSort('mileage_km')} />
                  <Chip label="Marque" active={sort === 'brand'} onPress={() => setSort('brand')} />
                  <Chip label={order === 'asc' ? '↑' : '↓'} active onPress={() => setOrder(order === 'asc' ? 'desc' : 'asc')} />
                </View>
              </View>
            </View>
          </View>
        ) : null}
        <Text style={textStyles.caption}>{bikes.length} moto{bikes.length > 1 ? 's' : ''}</Text>
      </View>

      <FlatList
        data={bikes}
        keyExtractor={(b) => b.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <EmptyState icon="🏍️" title="Aucune moto" hint="Ajoutez votre première moto 4T avec le bouton ci-dessous — même sans connexion." />
        }
        renderItem={({ item }) => (
          <BikeCard bike={item} onPress={() => navigation.navigate('BikeDetail', { id: item.id })} />
        )}
      />

      <Pressable
        onPress={() => navigation.navigate('BikeForm', {})}
        style={({ pressed }) => [styles.fab, pressed && { opacity: 0.9 }]}
      >
        <Text style={styles.fabText}>＋</Text>
      </Pressable>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8,
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8,
  },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 10,
    backgroundColor: colors.background,
  },
  searchIcon: { fontSize: 14 },
  searchInput: { flex: 1, paddingVertical: 9, fontSize: 15, color: colors.text },
  filters: { gap: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  chipTextActive: { color: '#fff' },
  priceRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  priceCol: { flex: 1 },
  priceInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10,
    paddingVertical: 8, fontSize: 14, color: colors.text, backgroundColor: colors.background,
  },
  list: { padding: 16, gap: 12, paddingBottom: 96 },
  fab: {
    position: 'absolute', right: 20, bottom: 24, width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    // `boxShadow` remplace les propriétés `shadow*` (dépréciées sur web, RN 0.86+)
    boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
  },
  fabText: { color: '#fff', fontSize: 28, fontWeight: '700', lineHeight: 30 },
});
