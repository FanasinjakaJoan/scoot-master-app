import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, textStyles } from '../theme';
import { formatDate, formatMoney } from '../lib/format';
import { Badge, PAYMENT_BADGES, SALE_BADGES } from './Badge';
import type { Sale } from '../types';

export function SaleCard({ sale, onPress, right }: { sale: Sale; onPress: () => void; right?: React.ReactNode }) {
  const s = SALE_BADGES[sale.status] || SALE_BADGES.brouillon;
  const p = PAYMENT_BADGES[sale.payment_status] || PAYMENT_BADGES.unpaid;
  const customer = sale.customer
    ? `${sale.customer.first_name} ${sale.customer.last_name}`
    : 'Client inconnu';
  const bikes = (sale.items || [])
    .map((it) => it.bike_id)
    .length;

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]}>
      <View style={styles.row}>
        <View style={styles.left}>
          <Text style={styles.number}>{sale.sale_number}</Text>
          <Text style={textStyles.caption}>
            {customer} · {formatDate(sale.sale_date)}
          </Text>
        </View>
        <Text style={styles.total}>{formatMoney(sale.total)}</Text>
      </View>
      <View style={styles.badges}>
        <Badge fg={s.fg} bg={s.bg}>{s.label}</Badge>
        <Badge fg={p.fg} bg={p.bg}>{p.label}</Badge>
        <Text style={textStyles.caption}>{bikes} moto{bikes > 1 ? 's' : ''}</Text>
      </View>
      {right}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1,
    borderColor: colors.border, padding: 12, gap: 8,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  left: { flex: 1 },
  number: { fontSize: 15, fontWeight: '800', color: colors.text },
  total: { fontSize: 16, fontWeight: '800', color: colors.primary },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
