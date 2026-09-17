import { StyleSheet } from 'react-native';

/** Thème Scoot Master — orange signature, surfaces claires. */
export const colors = {
  primary: '#FF5A1F',
  primaryDark: '#E04A12',
  primarySoft: '#FFF0EA',
  background: '#F6F7F9',
  surface: '#FFFFFF',
  text: '#17191C',
  textMuted: '#6B7280',
  border: '#E5E7EB',
  success: '#16A34A',
  successSoft: '#EAFBF1',
  warning: '#D97706',
  warningSoft: '#FFF7E8',
  danger: '#DC2626',
  dangerSoft: '#FDECEC',
  info: '#2563EB',
  infoSoft: '#EBF3FF',
};

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

export const textStyles = StyleSheet.create({
  h1: { fontSize: 24, fontWeight: '700', color: colors.text },
  h2: { fontSize: 18, fontWeight: '700', color: colors.text },
  body: { fontSize: 15, color: colors.text },
  caption: { fontSize: 13, color: colors.textMuted },
  label: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 4 },
});
