import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { colors } from '../theme';
import type { RootStackParamList } from './types';
import { LoginScreen } from '../screens/LoginScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { CatalogScreen } from '../screens/CatalogScreen';
import { BikeDetailScreen } from '../screens/BikeDetailScreen';
import { BikeFormScreen } from '../screens/BikeFormScreen';
import { SalesScreen } from '../screens/SalesScreen';
import { SaleDetailScreen } from '../screens/SaleDetailScreen';
import { SaleFormScreen } from '../screens/SaleFormScreen';
import { CustomersScreen } from '../screens/CustomersScreen';
import { CustomerDetailScreen } from '../screens/CustomerDetailScreen';
import { CustomerFormScreen } from '../screens/CustomerFormScreen';
import { SyncScreen } from '../screens/SyncScreen';
import { useApp } from '../store/AppStore';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator();

/**
 * Les écrans d'onglets sont typés avec les props de la pile racine (pour naviguer
 * vers les écrans de détail empilés) — le navigateur d'onglets, non générique,
 * attend des props minimales : on passe par ce cast (la navigation composite
 * résout 'BikeDetail' etc. via la pile parente au runtime).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asTab = (C: React.ComponentType<any>): React.ComponentType<object> => C as React.ComponentType<object>;

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  // Icônes emoji simples (aucune dépendance d'icônes)
  const map: Record<string, { on: string; off: string }> = {
    Dashboard: { on: '🏠', off: '🏠' },
    Catalog: { on: '🏍️', off: '🏍️' },
    Sales: { on: '🧾', off: '🧾' },
    Customers: { on: '👥', off: '👥' },
    Sync: { on: '🔄', off: '🔄' },
  };
  const t = map[name] || { on: '•', off: '•' };
  return <span style={{ fontSize: 16, opacity: focused ? 1 : 0.55 }}>{focused ? t.on : t.off}</span>;
}

function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarIcon: ({ focused }) => <TabIcon name={route.name} focused={focused} />,
      })}
    >
      <Tabs.Screen name="Dashboard" component={asTab(DashboardScreen)} options={{ title: 'Accueil' }} />
      <Tabs.Screen name="Catalog" component={asTab(CatalogScreen)} options={{ title: 'Catalogue' }} />
      <Tabs.Screen name="Sales" component={asTab(SalesScreen)} options={{ title: 'Ventes' }} />
      <Tabs.Screen name="Customers" component={asTab(CustomersScreen)} options={{ title: 'Clients' }} />
      <Tabs.Screen name="Sync" component={asTab(SyncScreen)} options={{ title: 'Sync' }} />
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  const { user } = useApp();

  if (!user) {
    return (
      <NavigationContainer>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Dashboard" component={LoginScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="Tabs" component={MainTabs} options={{ headerShown: false }} />
        <Stack.Screen name="BikeDetail" component={BikeDetailScreen} options={{ presentation: 'modal' }} />
        <Stack.Screen name="BikeForm" component={BikeFormScreen} options={{ presentation: 'modal' }} />
        <Stack.Screen name="CustomerDetail" component={CustomerDetailScreen} options={{ presentation: 'modal' }} />
        <Stack.Screen name="CustomerForm" component={CustomerFormScreen} options={{ presentation: 'modal' }} />
        <Stack.Screen name="SaleDetail" component={SaleDetailScreen} options={{ presentation: 'modal' }} />
        <Stack.Screen name="SaleForm" component={SaleFormScreen} options={{ presentation: 'modal' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
