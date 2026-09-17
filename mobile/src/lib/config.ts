/**
 * Configuration de l'app.
 *
 * L'URL de l'API est définie ici (ou via les extra du bundle).
 * Démo : le backend vit dans /backend (npm start → http://<hôte>:4000).
 */
export const API_BASE_URL: string =
  (typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_API_URL) ||
  'http://10.0.2.2:4000'; // 10.0.2.2 = hôte local vu d'Android emulator

export const APP_NAME = 'Scoot Master';

/** Lot maximal d'opérations par push (le serveur limite à 500). */
export const PUSH_BATCH_SIZE = 200;

/** Nombre maximal de tentatives avant qu'une opération soit marquée « en échec ». */
export const MAX_ATTEMPTS = 5;
