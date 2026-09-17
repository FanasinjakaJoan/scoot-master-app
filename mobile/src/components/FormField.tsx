import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, textStyles } from '../theme';

export function Field({
  label, value, onChangeText, placeholder, keyboardType, multiline, hint,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'phone-pad' | 'email-address' | 'decimal-pad';
  multiline?: boolean;
  hint?: string;
}) {
  return (
    <View style={styles.wrap}>
      <Text style={textStyles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        keyboardType={keyboardType}
        multiline={multiline}
        style={[styles.input, multiline && styles.inputMulti]}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Segmented<T extends string>({
  label, value, options, onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.wrap}>
      <Text style={textStyles.label}>{label}</Text>
      <View style={styles.segRow}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <View key={o.value} style={[styles.seg, active && styles.segActive]}>
              <Text
                onPress={() => onChange(o.value)}
                style={[styles.segText, active && styles.segTextActive]}
              >
                {o.label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12 },
  input: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 15, color: colors.text,
  },
  inputMulti: { minHeight: 70, textAlignVertical: 'top' },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
  segRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  seg: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  segActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  segText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  segTextActive: { color: '#fff' },
});
