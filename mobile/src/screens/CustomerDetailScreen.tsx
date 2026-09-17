import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { colors, textStyles } from '../theme';
import { useApp } from '../store/AppStore';
import { customerById, customerSalesStats, listSales } from '../data/local/repositories';
import { Screen, Card } from '../components/Screen';
import { EmptyState } from '../components/EmptyState';
import { SaleCard } from '../components/SaleCard';
import { Button, Row } from '../components/Buttons';
import { formatMoney, timeAgo } from '../lib/format';
import type { NavigatorProp } from '../navigation/types';

export function CustomerDetailScreen({ navigation, route }: NavigatorProp<'CustomerDetail'>) {
  const { dataVersion, deleteCustomer, user } = useApp();
  const id = route.params.id;
  const [customer, setCustomer] = useState(customerById(id));
  const [purchases, setPurchases] = useState(listSales({ customerId: id, limit: 100 }));

  useEffect(() => {
    setCustomer(customerById(id));
    setPurchases(listSales({ customerId: id, limit: 100 }));
  }, [id, dataVersion]);

  if (!customer) {
    return (
      <Screen title="Client" onBack={() => navigation.goBack()}>
        <EmptyState icon="❓" title="Client introuvable" />
      </Screen>
    );
  }

  const stats = customerSalesStats(id);

  const confirmDelete = () => {
    Alert.alert('Supprimer ce client ?', `${customer.first_name} ${customer.last_name} sera supprimé (les ventes sont conservées).`, [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Supprimer', style: 'destructive', onPress: () => { deleteCustomer(id); navigation.goBack(); } },
    ]);
  };

  return (
    <Screen
      title={`${customer.first_name} ${customer.last_name}`}
      subtitle={`Ajouté ${timeAgo(customer.created_at)}`}
      onBack={() => navigation.goBack()}
    >
      <Card>
        <View style={styles.contact}>
          <Text style={textStyles.body}>📞 {customer.phone}</Text>
          {customer.email ? <Text style={textStyles.body}>✉️ {customer.email}</Text> : null}
          {customer.address ? <Text style={textStyles.body}>📍 {customer.address}</Text> : null}
          {customer.notes ? <Text style={textStyles.caption}>📝 {customer.notes}</Text> : null}
        </View>
        <Row gap={10} style={{ marginTop: 10 }}>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{stats.nbSales}</Text>
            <Text style={textStyles.caption}>achats</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{formatMoney(stats.totalSpent)}</Text>
            <Text style={textStyles.caption}>total dépensé</Text>
          </View>
        </Row>
      </Card>

      <Text style={[textStyles.h2, styles.section]}>Historique des achats</Text>
      {purchases.length === 0 ? (
        <EmptyState icon="🧾" title="Aucun achat" hint="Les bons de commande de ce client apparaîtront ici." />
      ) : (
        purchases.map((s) => (
          <SaleCard key={s.id} sale={s} onPress={() => navigation.navigate('SaleDetail', { id: s.id })} />
        ))
      )}

      <Row gap={10}>
        <Button title="Modifier" variant="secondary" onPress={() => navigation.navigate('CustomerForm', { id: customer.id })} />
        {user?.role === 'admin' ? (
          <Button title="Supprimer" variant="danger" onPress={confirmDelete} />
        ) : null}
      </Row>
    </Screen>
  );
}

const styles = StyleSheet.create({
  contact: { gap: 6 },
  section: { marginBottom: 4, marginTop: 4 },
  statBox: {
    flex: 1, backgroundColor: colors.background, borderRadius: 10, padding: 10,
    alignItems: 'center', gap: 2,
  },
  statNum: { fontSize: 16, fontWeight: '800', color: colors.primary },
});
