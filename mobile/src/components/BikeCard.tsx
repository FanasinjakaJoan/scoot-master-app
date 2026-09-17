import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, textStyles } from '../theme';
import { formatKm, formatMoney } from '../lib/format';
import { Badge, BIKE_BADGES } from './Badge';
import type { Bike } from '../types';

export function BikeCard({ bike, onPress, right }: { bike: Bike; onPress: () => void; right?: React.ReactNode }) {
  const badge = BIKE_BADGES[bike.status] || BIKE_BADGES.available;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]}
    >
      <View style={styles.top}>
        <View style={styles.titleCol}>
          <Text style={textStyles.h2} numberOfLines={1}>
            {bike.brand} {bike.model}
          </Text>
          <Text style={textStyles.caption}>
            {[bike.year, formatKm(bike.mileage_km), bike.engine_cc ? `${bike.engine_cc} cc` : null]
              .filter(Boolean).join(' · ')}
            {bike.color ? ` · ${bike.color}` : ''}
          </Text>
        </View>
        <Badge fg={badge.fg} bg={badge.bg}>{badge.label}</Badge>
      </View>
      <View style={styles.bottom}>
        <Text style={styles.price}>{formatMoney(bike.price, bike.currency)}</Text>
        <View style={styles.states}>
          <Text style={textStyles.caption}>Méca {bike.mechanical_state}/5 · Esth. {bike.aesthetic_state}/5</Text>
        </View>
      </View>
      {right}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1,
    borderColor: colors.border, padding: 12, gap: 10,
  },
  top: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  titleCol: { flex: 1 },
  bottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  price: { fontSize: 17, fontWeight: '800', color: colors.primary },
  states: { flex: 1, alignItems: 'flex-end' },
});
