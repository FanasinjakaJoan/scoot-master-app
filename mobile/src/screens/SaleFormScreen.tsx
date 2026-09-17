import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, textStyles } from '../theme';
import { useApp, useCustomers, useBikes, newEntityId } from '../store/AppStore';
import { Screen, Card } from '../components/Screen';
import { Field, Segmented } from '../components/FormField';
import { Button } from '../components/Buttons';
import { formatMoney, todayIsoDate } from '../lib/format';
import { PAYMENT_METHODS } from '../types';
import type { Bike, PaymentMethod, SaleStatus } from '../types';
import type { NavigatorProp } from '../navigation/types';

interface Item {
  bike: Bike;
  quantity: number;
  unitPrice: number;
}

export function SaleFormScreen({ navigation, route }: NavigatorProp<'SaleForm'>) {
  const { saveSale, saveCustomer, user } = useApp();
  const editId = route.params?.id;
  const customers = useCustomers();
  const available = useBikes({ status: 'available' });

  const [customerId, setCustomerId] = useState<string>('');
  const [newCustomer, setNewCustomer] = useState(false);
  const [cFirst, setCFirst] = useState('');
  const [cLast, setCLast] = useState('');
  const [cPhone, setCPhone] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [discount, setDiscount] = useState('');
  const [amountPaid, setAmountPaid] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [status, setStatus] = useState<SaleStatus>('brouillon');
  const [saleDate, setSaleDate] = useState(todayIsoDate());
  const [notes, setNotes] = useState('');

  const gross = useMemo(
    () => items.reduce((s, it) => s + it.unitPrice * it.quantity, 0),
    [items]
  );
  const total = gross - (Number(discount) || 0);

  function addBike(bike: Bike) {
    setItems((prev) => {
      if (prev.some((it) => it.bike.id === bike.id)) return prev;
      return [...prev, { bike, quantity: 1, unitPrice: bike.price }];
    });
  }

  function updateItem(idx: number, patch: Partial<Item>) {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  function submit() {
    // Client : sélectionné ou nouveau
    let cid = customerId;
    if (newCustomer) {
      if (!cFirst.trim() || !cLast.trim() || !cPhone.trim()) {
        Alert.alert('Client incomplet', 'Prénom, nom et téléphone sont requis.');
        return;
      }
      cid = newEntityId();
      saveCustomer({
        id: cid,
        first_name: cFirst.trim(),
        last_name: cLast.trim(),
        phone: cPhone.trim(),
        email: null,
        address: null,
        notes: null,
      });
    } else if (!cid) {
      Alert.alert('Client requis', 'Choisissez un client ou créez-en un.');
      return;
    }

    if (items.length === 0) {
      Alert.alert('Aucune moto', 'Ajoutez au moins une moto au bon de commande.');
      return;
    }

    const sale = saveSale({
      id: editId || newEntityId(),
      customer_id: cid,
      items: items.map((it) => ({ bike_id: it.bike.id, unit_price: it.unitPrice, quantity: it.quantity })),
      discount: Number(discount) || 0,
      amount_paid: Number(amountPaid) || 0,
      payment_method: paymentMethod,
      status,
      sale_date: saleDate,
      notes: notes.trim() || null,
    });
    navigation.navigate('SaleDetail', { id: sale.id });
  }

  return (
    <Screen
      title={editId ? 'Modifier le bon' : 'Nouveau bon de commande'}
      subtitle="100 % hors ligne : le bon est enregistré localement puis synchronisé."
      onBack={() => navigation.goBack()}
    >
      {/* ---- Client ---- */}
      <Card>
        <Text style={textStyles.h2}>Client</Text>
        <View style={styles.modeRow}>
          <Button small variant={!newCustomer ? 'primary' : 'secondary'} title="Client existant" onPress={() => setNewCustomer(false)} />
          <Button small variant={newCustomer ? 'primary' : 'secondary'} title="＋ Nouveau client" onPress={() => setNewCustomer(true)} />
        </View>
        {newCustomer ? (
          <View style={{ marginTop: 12 }}>
            <View style={styles.row}>
              <View style={styles.half}><Field label="Prénom *" value={cFirst} onChangeText={setCFirst} placeholder="Rija" /></View>
              <View style={styles.half}><Field label="Nom *" value={cLast} onChangeText={setCLast} placeholder="Ando" /></View>
            </View>
            <Field label="Téléphone *" value={cPhone} onChangeText={setCPhone} keyboardType="phone-pad" placeholder="+261 34 00 000 00" />
          </View>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10, marginBottom: 4 }}>
            <View style={styles.customerRow}>
              {customers.length === 0 ? (
                <Text style={textStyles.caption}>Aucun client — créez-en un.</Text>
              ) : (
                customers.slice(0, 30).map((c) => (
                  <Pressable
                    key={c.id}
                    onPress={() => setCustomerId(c.id)}
                    style={[styles.customerChip, customerId === c.id && styles.customerChipActive]}
                  >
                    <Text style={[styles.customerChipText, customerId === c.id && { color: '#fff' }]}>
                      {c.first_name} {c.last_name}
                    </Text>
                  </Pressable>
                ))
              )}
            </View>
          </ScrollView>
        )}
      </Card>

      {/* ---- Motos ---- */}
      <Card>
        <Text style={textStyles.h2}>Motos ({items.length})</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bikeRow}>
          {available.map((b) => (
            <Pressable
              key={b.id}
              onPress={() => addBike(b)}
              style={[styles.bikeChip, items.some((it) => it.bike.id === b.id) && styles.bikeChipActive]}
            >
              <Text style={[styles.bikeChipText, items.some((it) => it.bike.id === b.id) && { color: '#fff' }]}>
                {b.brand} {b.model}
              </Text>
              <Text style={[styles.bikeChipSub, items.some((it) => it.bike.id === b.id) && { color: '#fff' }]}>
                {formatMoney(b.price)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        {available.length === 0 ? <Text style={textStyles.caption}>Aucune moto disponible au catalogue.</Text> : null}

        {items.map((it, idx) => (
          <View key={it.bike.id} style={styles.itemRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.itemName}>{it.bike.brand} {it.bike.model}</Text>
              <View style={styles.itemInputs}>
                <View style={styles.itemInputWrap}>
                  <Text style={textStyles.caption}>Qté</Text>
                  <View style={styles.qtyRow}>
                    <Button small variant="secondary" title="−" onPress={() => updateItem(idx, { quantity: Math.max(1, it.quantity - 1) })} />
                    <Text style={styles.qtyNum}>{it.quantity}</Text>
                    <Button small variant="secondary" title="＋" onPress={() => updateItem(idx, { quantity: it.quantity + 1 })} />
                  </View>
                </View>
                <View style={styles.itemInputWrap}>
                  <Text style={textStyles.caption}>Prix unitaire</Text>
                  <View style={styles.priceInput}>
                    <Text style={styles.priceText}>{formatMoney(it.unitPrice)}</Text>
                    <View style={styles.qtyRow}>
                      <Button small variant="ghost" title="-50k" onPress={() => updateItem(idx, { unitPrice: Math.max(0, it.unitPrice - 50000) })} />
                      <Button small variant="ghost" title="+50k" onPress={() => updateItem(idx, { unitPrice: it.unitPrice + 50000 })} />
                    </View>
                  </View>
                </View>
              </View>
            </View>
            <Text
              onPress={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
              style={styles.itemRemove}
            >
              ✕
            </Text>
          </View>
        ))}

        <View style={styles.totals}>
          <View style={styles.totalLine}>
            <Text style={textStyles.body}>Sous-total</Text>
            <Text style={textStyles.body}>{formatMoney(gross)}</Text>
          </View>
          <View style={styles.totalLine}>
            <Text style={textStyles.body}>Remise (Ar)</Text>
            <View style={styles.remiseInput}>
              <Text style={styles.priceText}>{formatMoney(Number(discount) || 0)}</Text>
              <View style={styles.qtyRow}>
                <Button small variant="ghost" title="-50k" onPress={() => setDiscount(String(Math.max(0, (Number(discount) || 0) - 50000)))} />
                <Button small variant="ghost" title="+50k" onPress={() => setDiscount(String((Number(discount) || 0) + 50000))} />
              </View>
            </View>
          </View>
          <View style={styles.totalLineBig}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatMoney(total)}</Text>
          </View>
        </View>
      </Card>

      {/* ---- Paiement & statut ---- */}
      <Card>
        <Segmented
          label="Mode de paiement"
          value={paymentMethod}
          options={PAYMENT_METHODS.map((m) => ({ value: m.value, label: m.label }))}
          onChange={(v) => setPaymentMethod(v)}
        />
        <Field label="Montant payé (Ar)" value={amountPaid} onChangeText={setAmountPaid} keyboardType="numeric"
          placeholder="0 (avance, acompte…)" />
        <View style={styles.row}>
          <View style={styles.half}>
            <Segmented
              label="Statut du bon"
              value={status}
              options={[
                { value: 'brouillon', label: 'Brouillon' },
                { value: 'confirme', label: 'Confirmée' },
              ]}
              onChange={(v) => setStatus(v)}
            />
          </View>
          <View style={styles.half}>
            <Field label="Date" value={saleDate} onChangeText={setSaleDate} keyboardType="numeric" hint="AAAA-MM-JJ" />
          </View>
        </View>
        <Field label="Notes" value={notes} onChangeText={setNotes} multiline placeholder="Livraison, garantie…" />
      </Card>

      <Button
        title={status === 'confirme' ? 'Enregistrer et valider la vente' : 'Enregistrer le brouillon'}
        onPress={submit}
      />
      {status === 'confirme' ? (
        <Text style={textStyles.caption}>
          ⚠️ Une vente confirmée passe les motos sélectionnées au statut « Vendue ».
        </Text>
      ) : null}
      {user?.role !== 'admin' ? (
        <Text style={textStyles.caption}>Suppression d'un bon : réservée à l'administrateur.</Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  modeRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  row: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  customerRow: { flexDirection: 'row', gap: 6, paddingVertical: 4 },
  customerChip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background,
  },
  customerChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  customerChipText: { fontSize: 12, fontWeight: '700', color: colors.text },
  bikeRow: { marginTop: 10, marginBottom: 8 },
  bikeChip: {
    width: 130, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.background, padding: 10, gap: 2,
  },
  bikeChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  bikeChipText: { fontSize: 12, fontWeight: '700', color: colors.text },
  bikeChipSub: { fontSize: 11, color: colors.textMuted },
  itemRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border,
  },
  itemName: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: 8 },
  itemInputs: { flexDirection: 'row', gap: 16 },
  itemInputWrap: { gap: 4 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  qtyNum: { fontSize: 15, fontWeight: '700', minWidth: 24, textAlign: 'center' },
  priceInput: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  priceText: { fontSize: 13, fontWeight: '700', color: colors.text },
  itemRemove: { color: colors.danger, fontSize: 16, fontWeight: '700', padding: 6 },
  totals: { marginTop: 12, gap: 6 },
  totalLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  remiseInput: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  totalLineBig: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border,
  },
  totalLabel: { fontSize: 16, fontWeight: '800', color: colors.text },
  totalValue: { fontSize: 20, fontWeight: '800', color: colors.primary },
});
