import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variantStyles: Record<Variant, { bg: string; fg: string; border?: string }> = {
  primary: { bg: colors.primary, fg: '#fff' },
  secondary: { bg: colors.surface, fg: colors.text, border: colors.border },
  danger: { bg: colors.dangerSoft, fg: colors.danger, border: colors.danger + '44' },
  ghost: { bg: 'transparent', fg: colors.primary },
};

export function Button({
  title, onPress, variant = 'primary', disabled, small,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  small?: boolean;
}) {
  const v = variantStyles[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        {
          backgroundColor: v.bg,
          borderColor: v.border || 'transparent',
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text style={[styles.text, small && styles.textSmall, { color: v.fg }]}>{title}</Text>
    </Pressable>
  );
}

export function Row({ children, gap = 8, style }: { children: React.ReactNode; gap?: number; style?: object }) {
  return <View style={[{ flexDirection: 'row', gap, alignItems: 'center' }, style as object]}>{children}</View>;
}

const styles = StyleSheet.create({
  btn: {
    borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: 16,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1,
  },
  btnSmall: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: radius.sm },
  text: { fontSize: 15, fontWeight: '700' },
  textSmall: { fontSize: 12 },
});
