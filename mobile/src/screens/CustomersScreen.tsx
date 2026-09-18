import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { colors, textStyles } from '../theme';
import { useCustomers } from '../store/AppStore';
import { customerSalesStats } from '../data/local/repositories';
import { Card } from '../components/Screen';
import { EmptyState } from '../components/EmptyState';
import { formatMoney } from '../lib/format';
import type { NavigatorProp } from '../navigation/types';

export function CustomersScreen({ navigation }: NavigatorProp<'Customers'>) {
  const [q, setQ] = useState('');
  const customers = useCustomers(q.trim() || undefined);

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={textStyles.h1}>Clients</Text>
        <View style={styles.searchRow}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Nom, téléphone, email…"
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
          />
        </View>
        <Text style={textStyles.caption}>{customers.length} client{customers.length > 1 ? 's' : ''}</Text>
      </View>

      <FlatList
        data={customers}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<EmptyState icon="👥" title="Aucun client" hint="Créez votre premier client avec le bouton ci-dessous." />}
        renderItem={({ item }) => {
          const stats = customerSalesStats(item.id);
          return (
            <Card>
              <Pressable onPress={() => navigation.navigate('CustomerDetail', { id: item.id })}>
                <View style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={textStyles.h2}>{item.first_name} {item.last_name}</Text>
                    <Text style={textStyles.caption}>{item.phone}</Text>
                  </View>
                  <View style={styles.stats}>
                    <Text style={styles.statsNum}>{stats.nbSales}</Text>
                    <Text style={textStyles.caption}>achat{stats.nbSales > 1 ? 's' : ''}</Text>
                  </View>
                </View>
                {stats.totalSpent > 0 ? (
                  <Text style={styles.spent}>Total dépensé : {formatMoney(stats.totalSpent)}</Text>
                ) : null}
              </Pressable>
            </Card>
          );
        }}
      />

      <Pressable
        onPress={() => navigation.navigate('CustomerForm', {})}
        style={({ pressed }) => [styles.fab, pressed && { opacity: 0.9 }]}
      >
        <Text style={styles.fabText}>＋</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8,
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8,
  },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 10,
    backgroundColor: colors.background,
  },
  searchIcon: { fontSize: 14 },
  searchInput: { flex: 1, paddingVertical: 9, fontSize: 15, color: colors.text },
  list: { padding: 16, gap: 12, paddingBottom: 96 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  stats: { alignItems: 'flex-end' },
  statsNum: { fontSize: 18, fontWeight: '800', color: colors.primary },
  spent: { marginTop: 6, fontSize: 13, color: colors.textMuted },
  fab: {
    position: 'absolute', right: 20, bottom: 24, width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    // `boxShadow` remplace les propriétés `shadow*` (dépréciées sur web, RN 0.86+)
    boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
  },
  fabText: { color: '#fff', fontSize: 28, fontWeight: '700', lineHeight: 30 },
});
