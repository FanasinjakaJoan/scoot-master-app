import { Platform } from 'react-native';

/**
 * Stockage sécurisé de petites valeurs (jeton JWT, session).
 *
 * - iOS / Android : `expo-secure-store` (Keychain / Keystore).
 * - Web : `localStorage` — le module SecureStore n'a pas d'implémentation
 *   navigateur ; ce repli permet de faire tourner l'app dans un navigateur
 *   (démonstration / tests sur PC et mobile).
 */

interface SecureKV {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
}

const IS_WEB = Platform.OS === 'web';

// Chargé uniquement en natif : évite d'évaluer un module sans support web.
const nativeStore: SecureKV | null = IS_WEB
  ? null
  : (require('expo-secure-store') as SecureKV);

export async function secureGet(key: string): Promise<string | null> {
  if (nativeStore) return nativeStore.getItemAsync(key);
  try { return globalThis.localStorage.getItem(key); } catch { return null; }
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (nativeStore) return nativeStore.setItemAsync(key, value);
  try { globalThis.localStorage.setItem(key, value); } catch { /* stockage plein/indispo */ }
}

export async function secureDelete(key: string): Promise<void> {
  if (nativeStore) return nativeStore.deleteItemAsync(key);
  try { globalThis.localStorage.removeItem(key); } catch { /* rien */ }
}
