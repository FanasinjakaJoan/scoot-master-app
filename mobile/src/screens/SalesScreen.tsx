import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { colors, textStyles } from '../theme';
import { useSales } from '../store/AppStore';
import { SaleCard } from '../components/SaleCard';
import { EmptyState } from '../components/EmptyState';
import { SALE_STATUSES } from '../types';
import type { NavigatorProp } from '../navigation/types';

export function SalesScreen({ navigation }: NavigatorProp<'Sales'>) {
  const [status, setStatus] = useState<string | undefined>(undefined);
  const sales = useSales(status ? { status } : {});

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={textStyles.h1}>Ventes &amp; bons de commande</Text>
        <View style={styles.chipRow}>
          <Chip label="Toutes" active={!status} onPress={() => setStatus(undefined)} />
          {SALE_STATUSES.map((s) => (
            <Chip
              key={s.value}
              label={s.label}
              active={status === s.value}
              onPress={() => setStatus(status === s.value ? undefined : s.value)}
            />
          ))}
        </View>
        <Text style={textStyles.caption}>
          {sales.length} vente{sales.length > 1 ? 's' : ''} — enregistrement possible hors ligne
        </Text>
      </View>

      <FlatList
        data={sales}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <EmptyState icon="🧾" title="Aucun bon de commande" hint="Créez un bon avec le bouton ci-dessous — même sans internet." />
        }
        renderItem={({ item }) => (
          <SaleCard sale={item} onPress={() => navigation.navigate('SaleDetail', { id: item.id })} />
        )}
      />

      <Pressable
        onPress={() => navigation.navigate('SaleForm', {})}
        style={({ pressed }) => [styles.fab, pressed && { opacity: 0.9 }]}
      >
        <Text style={styles.fabText}>＋</Text>
      </Pressable>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  chipTextActive: { color: '#fff' },
  list: { padding: 16, gap: 12, paddingBottom: 96 },
  fab: {
    position: 'absolute', right: 20, bottom: 24, width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    // `boxShadow` remplace les propriétés `shadow*` (dépréciées sur web, RN 0.86+)
    boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
  },
  fabText: { color: '#fff', fontSize: 28, fontWeight: '700', lineHeight: 30 },
});
