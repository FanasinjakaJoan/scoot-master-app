import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { colors, textStyles } from '../theme';
import { useApp, useDashboard, useSales } from '../store/AppStore';
import { StatusPill } from '../components/StatusPill';
import { SaleCard } from '../components/SaleCard';
import { Card } from '../components/Screen';
import { EmptyState } from '../components/EmptyState';
import { formatMoney, timeAgo } from '../lib/format';
import type { NavigatorProp } from '../navigation/types';

export function DashboardScreen({ navigation }: NavigatorProp<'Dashboard'>) {
  const app = useApp();
  const d = useDashboard();
  const recent = useSales();

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={textStyles.h1}>Bonjour, {app.user?.fullName?.split(' ')[0] || ' '} 👋</Text>
        <Text style={textStyles.caption}>
          {timeAgo(app.sync.lastSyncAt)} · {app.user?.role === 'admin' ? 'Administrateur' : 'Vendeur'}
        </Text>
      </View>
      <View style={styles.body}>
        <StatusPill
          online={app.online}
          syncing={app.sync.syncing}
          lastSyncAt={app.sync.lastSyncAt}
          pending={app.sync.pendingCount}
          conflicts={app.sync.conflictCount}
          failed={app.sync.failedCount}
          onPress={() => navigation.navigate('Sync')}
        />

        <View style={styles.grid}>
          <StatCard icon="🏍️" label="Motos disponibles" value={String(d.availableBikes ?? 0)} onPress={() => navigation.navigate('Catalog')} />
          <StatCard icon="💰" label="Valeur du stock" value={formatMoney(d.stockValue ?? 0)} onPress={() => navigation.navigate('Catalog')} />
          <StatCard icon="🧾" label="Ventes ce mois" value={String(d.salesThisMonth ?? 0)} onPress={() => navigation.navigate('Sales')} />
          <StatCard icon="👥" label="Clients" value={String(d.customersCount ?? 0)} onPress={() => navigation.navigate('Customers')} />
        </View>

        <Card>
          <View style={styles.monthRow}>
            <Text style={textStyles.h2}>Chiffre d'affaires du mois</Text>
            <Text style={styles.ca}>{formatMoney(d.revenueThisMonth ?? 0)}</Text>
          </View>
        </Card>

        <Text style={[textStyles.h2, styles.section]}>Dernières ventes</Text>
        {recent.length === 0 ? (
          <EmptyState icon="🧾" title="Aucune vente" hint="Créez votre premier bon de commande depuis l'onglet Ventes — ça marche même hors ligne." />
        ) : (
          recent.slice(0, 4).map((s) => (
            <SaleCard
              key={s.id}
              sale={s}
              onPress={() => navigation.navigate('SaleDetail', { id: s.id })}
            />
          ))
        )}
      </View>
    </View>
  );
}

function StatCard({ icon, label, value, onPress }: { icon: string; label: string; value: string; onPress: () => void }) {
  return (
    <Card>
      <Text onPress={onPress} style={styles.statIcon}>{icon}</Text>
      <Text onPress={onPress} style={styles.statValue} numberOfLines={1}>{value}</Text>
      <Text onPress={onPress} style={textStyles.caption}>{label}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10,
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  body: { flex: 1, padding: 16, gap: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  monthRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  ca: { fontSize: 18, fontWeight: '800', color: colors.success },
  section: { marginTop: 4 },
  statIcon: { fontSize: 22 },
  statValue: { fontSize: 20, fontWeight: '800', color: colors.text, marginTop: 4 },
});
