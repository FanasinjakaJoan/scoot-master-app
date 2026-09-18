import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Alert } from '../lib/alert';
import { colors, textStyles } from '../theme';
import { useApp } from '../store/AppStore';
import { saleById, bikeById } from '../data/local/repositories';
import { Screen, Card } from '../components/Screen';
import { Badge, PAYMENT_BADGES, SALE_BADGES } from '../components/Badge';
import { Button, Row } from '../components/Buttons';
import { EmptyState } from '../components/EmptyState';
import { formatMoney, timeAgo } from '../lib/format';
import type { SaleStatus } from '../types';
import type { NavigatorProp } from '../navigation/types';

export function SaleDetailScreen({ navigation, route }: NavigatorProp<'SaleDetail'>) {
  const { dataVersion, patchSaleStatus, deleteSale, user } = useApp();
  const id = route.params.id;
  const [sale, setSale] = useState(saleById(id));

  useEffect(() => { setSale(saleById(id)); }, [id, dataVersion]);

  if (!sale) {
    return (
      <Screen title="Vente" onBack={() => navigation.goBack()}>
        <EmptyState icon="❓" title="Vente introuvable" />
      </Screen>
    );
  }

  const s = SALE_BADGES[sale.status] || SALE_BADGES.brouillon;
  const p = PAYMENT_BADGES[sale.payment_status] || PAYMENT_BADGES.unpaid;

  const act = (status: SaleStatus, label: string) => {
    Alert.alert(label, `Passer le bon ${sale.sale_number} au statut « ${SALE_BADGES[status].label} » ?`, [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Valider', onPress: () => patchSaleStatus(sale.id, status) },
    ]);
  };

  const confirmDelete = () => {
    Alert.alert('Supprimer ce bon ?', 'Les motos concernées seront remises en stock (si libres).', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Supprimer', style: 'destructive', onPress: () => { deleteSale(sale.id); navigation.goBack(); } },
    ]);
  };

  return (
    <Screen
      title={sale.sale_number}
      subtitle={`Créé ${timeAgo(sale.created_at)} · ${sale.sale_date}`}
      onBack={() => navigation.goBack()}
    >
      <Card>
        <Row gap={8}>
          <Badge fg={s.fg} bg={s.bg}>{s.label}</Badge>
          <Badge fg={p.fg} bg={p.bg}>{p.label}</Badge>
        </Row>
        {sale.customer ? (
          <View style={styles.customer}>
            <Text style={textStyles.h2}>{sale.customer.first_name} {sale.customer.last_name}</Text>
            <Text style={textStyles.caption}>{sale.customer.phone}</Text>
          </View>
        ) : (
          <Text style={textStyles.caption}>Client inconnu</Text>
        )}
      </Card>

      <Card>
        <Text style={[textStyles.h2, styles.section]}>Lignes</Text>
        {(sale.items || []).map((it) => {
          const bike = bikeById(it.bike_id);
          return (
            <View key={it.id} style={styles.itemRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>
                  {bike ? `${bike.brand} ${bike.model}` : 'Moto retirée du catalogue'}
                </Text>
                <Text style={textStyles.caption}>
                  {formatMoney(it.unit_price)} × {it.quantity}
                </Text>
              </View>
              <Text style={styles.itemTotal}>{formatMoney(it.unit_price * it.quantity)}</Text>
            </View>
          );
        })}
        <View style={styles.totals}>
          <View style={styles.line}><Text style={textStyles.body}>Sous-total</Text><Text style={textStyles.body}>{formatMoney(sale.total + sale.discount)}</Text></View>
          <View style={styles.line}><Text style={textStyles.body}>Remise</Text><Text style={[textStyles.body, { color: colors.success }]}>- {formatMoney(sale.discount)}</Text></View>
          <View style={styles.lineBig}><Text style={styles.totalLabel}>Total</Text><Text style={styles.totalValue}>{formatMoney(sale.total)}</Text></View>
          <View style={styles.line}><Text style={textStyles.body}>Payé</Text><Text style={textStyles.body}>{formatMoney(sale.amount_paid)}</Text></View>
          <View style={styles.line}><Text style={textStyles.body}>Reste à payer</Text><Text style={[textStyles.body, { color: sale.total - sale.amount_paid > 0 ? colors.danger : colors.success, fontWeight: '700' }]}>{formatMoney(Math.max(0, sale.total - sale.amount_paid))}</Text></View>
        </View>
        {sale.notes ? <Text style={[textStyles.caption, styles.notes]}>📝 {sale.notes}</Text> : null}
      </Card>

      <Card>
        <Text style={[textStyles.h2, styles.section]}>Actions</Text>
        <View style={styles.actions}>
          {sale.status === 'brouillon' ? (
            <Button small title="✔ Confirmer la vente" onPress={() => act('confirme', 'Confirmation')} />
          ) : null}
          {sale.status === 'confirme' ? (
            <Button small title="🚚 Marquer livrée" variant="secondary" onPress={() => act('livre', 'Livraison')} />
          ) : null}
          {sale.status !== 'annule' && sale.status !== 'brouillon' ? (
            <Button small title="Annuler" variant="danger" onPress={() => act('annule', 'Annulation')} />
          ) : null}
          {user?.role === 'admin' ? (
            <Button small title="Supprimer" variant="danger" onPress={confirmDelete} />
          ) : null}
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  customer: { marginTop: 10 },
  section: { marginBottom: 8 },
  itemRow: {
    flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8,
  },
  itemName: { fontSize: 14, fontWeight: '700', color: colors.text },
  itemTotal: { fontSize: 14, fontWeight: '700', color: colors.text },
  totals: { marginTop: 8, gap: 6 },
  line: { flexDirection: 'row', justifyContent: 'space-between' },
  lineBig: {
    flexDirection: 'row', justifyContent: 'space-between', paddingTop: 6,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  totalLabel: { fontSize: 16, fontWeight: '800' },
  totalValue: { fontSize: 20, fontWeight: '800', color: colors.primary },
  notes: { marginTop: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
