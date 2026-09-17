import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme';
import type { BikeStatus, PaymentStatus, SaleStatus } from '../types';

export const BIKE_BADGES: Record<BikeStatus, { label: string; fg: string; bg: string }> = {
  available: { label: 'Disponible', fg: colors.success, bg: colors.successSoft },
  reserved: { label: 'Réservée', fg: colors.warning, bg: colors.warningSoft },
  maintenance: { label: 'Maintenance', fg: colors.info, bg: colors.infoSoft },
  sold: { label: 'Vendue', fg: colors.danger, bg: colors.dangerSoft },
};

export const SALE_BADGES: Record<SaleStatus, { label: string; fg: string; bg: string }> = {
  brouillon: { label: 'Brouillon', fg: colors.textMuted, bg: colors.background },
  confirme: { label: 'Confirmée', fg: colors.info, bg: colors.infoSoft },
  livre: { label: 'Livrée', fg: colors.success, bg: colors.successSoft },
  annule: { label: 'Annulée', fg: colors.danger, bg: colors.dangerSoft },
};

export const PAYMENT_BADGES: Record<PaymentStatus, { label: string; fg: string; bg: string }> = {
  paid: { label: 'Payée', fg: colors.success, bg: colors.successSoft },
  partial: { label: 'Partielle', fg: colors.warning, bg: colors.warningSoft },
  unpaid: { label: 'Non payée', fg: colors.danger, bg: colors.dangerSoft },
};

export function Badge({ fg, bg, children }: { fg: string; bg: string; children: React.ReactNode }) {
  return (
    <View style={[styles.badge, { borderColor: fg + '33', backgroundColor: bg }]}>
      <Text style={[styles.text, { color: fg }]}>{children}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  text: { fontSize: 11, fontWeight: '700' },
});
