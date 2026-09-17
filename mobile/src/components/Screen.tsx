import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, textStyles } from '../theme';

export function Screen({
  title, subtitle, children, onBack, right,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onBack?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        {onBack ? (
          <View style={styles.backRow}>
            <Text onPress={onBack} style={styles.back}>←</Text>
            <Text style={[textStyles.h1, styles.title]}>{title}</Text>
          </View>
        ) : (
          <Text style={[textStyles.h1, styles.title]}>{title}</Text>
        )}
        {subtitle ? <Text style={[textStyles.caption, styles.subtitle]}>{subtitle}</Text> : null}
      </View>
      {right}
      <ScrollView style={styles.body} contentContainerStyle={styles.bodyInner} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: object }) {
  return <View style={[styles.card, style as object]}>{children}</View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8,
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  back: { fontSize: 22, color: colors.primary, fontWeight: '700', paddingHorizontal: 2 },
  title: { flex: 1 },
  subtitle: { marginTop: 2 },
  body: { flex: 1 },
  bodyInner: { padding: 16, gap: 12 },
  card: {
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1,
    borderColor: colors.border, padding: 12,
  },
});
