import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from './src/store/AppStore';
import { RootNavigator } from './src/navigation/RootNavigator';

/**
 * Scoot Master — application mobile offline-first
 * (catalogue motos 4T, ventes, clients, synchronisation avec résolution de conflits).
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <RootNavigator />
      </AppProvider>
    </SafeAreaProvider>
  );
}
