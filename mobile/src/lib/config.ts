/**
 * Configuration de l'app.
 *
 * L'URL de l'API est définie ici (ou via les extra du bundle).
 * Démo : le backend vit dans /backend (npm start → http://<hôte>:4000).
 */
const envApiUrl: string | undefined =
  typeof process !== 'undefined' && process.env ? process.env.EXPO_PUBLIC_API_URL : undefined;

/**
 * URL de base de l'API.
 * - Variable `EXPO_PUBLIC_API_URL` injectée au build (y compris chaîne vide
 *   `''` ⇒ chemins relatifs, API servie sur la même origine — déploiements
 *   conteneurisés où le reverse-proxy expose l'app et l'API ensemble).
 * - Défaut : hôte local vu depuis l'émulateur Android.
 */
export const API_BASE_URL: string =
  envApiUrl !== undefined ? envApiUrl : 'http://10.0.2.2:4000';

export const APP_NAME = 'Scoot Master';

/** Lot maximal d'opérations par push (le serveur limite à 500). */
export const PUSH_BATCH_SIZE = 200;

/** Nombre maximal de tentatives avant qu'une opération soit marquée « en échec ». */
export const MAX_ATTEMPTS = 5;
