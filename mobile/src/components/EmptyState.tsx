import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, textStyles } from '../theme';

export function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.icon}>{icon}</Text>
      <Text style={textStyles.h2}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center', justifyContent: 'center', paddingVertical: 40, gap: 6,
  },
  icon: { fontSize: 40 },
  hint: { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingHorizontal: 32 },
});
