/**
 * Configuration de l'app.
 *
 * L'URL de l'API est définie ici (ou via les extra du bundle).
 * Démo : le backend vit dans /backend (npm start → http://<hôte>:4000).
 */
import { Platform } from 'react-native';

const envApiUrl: string | undefined =
  typeof process !== 'undefined' && process.env ? process.env.EXPO_PUBLIC_API_URL : undefined;

const envApkUrl: string | undefined =
  typeof process !== 'undefined' && process.env ? process.env.EXPO_PUBLIC_APK_URL : undefined;

const envInstallUrl: string | undefined =
  typeof process !== 'undefined' && process.env ? process.env.EXPO_PUBLIC_INSTALL_URL : undefined;

/**
 * URL de base de l'API.
 * - Variable `EXPO_PUBLIC_API_URL` injectée au build (y compris chaîne vide
 *   `''` ⇒ chemins relatifs, API servie sur la même origine — déploiements
 *   conteneurisés où le reverse-proxy expose l'app et l'API ensemble).
 * - Navigateur : chemins relatifs par défaut (`/api/…`) — le serveur web
 *   (Metro en développement, `deploy/web-server.js` en production) relaie
 *   `/api` vers le backend ; aucune adresse à saisir et pas de CORS.
 * - Émulateur Android : hôte local `10.0.2.2`.
 */
export const API_BASE_URL: string =
  envApiUrl !== undefined
    ? envApiUrl
    : Platform.OS === 'web'
      ? ''
      : 'http://10.0.2.2:4000';

export const APP_NAME = 'Scoot Master';

/** Lot maximal d'opérations par push (le serveur limite à 500). */
export const PUSH_BATCH_SIZE = 200;

/** Nombre maximal de tentatives avant qu'une opération soit marquée « en échec ». */
export const MAX_ATTEMPTS = 5;

/** Dépôt GitHub du projet (raccourcis d'installation). */
export const REPO_URL = 'https://github.com/FanasinjakaJoan/scoot-master-app';

/**
 * APK Android téléchargeable depuis l'app.
 * Par défaut : l'asset de la **dernière Release GitHub** (URL stable et publique,
 * publiée par `.github/workflows/apk.yml` à chaque build sur `main`).
 * Surcharge au build : `EXPO_PUBLIC_APK_URL=https://mon-serveur/scoot.apk`.
 */
export const APK_DOWNLOAD_URL: string =
  envApkUrl ?? `${REPO_URL}/releases/latest/download/scoot-master-latest.apk`;

/**
 * Page « Installer Scoot Master » servie par le serveur web
 * (`deploy/web-server.js` → `GET /install`) : APK local + procédures
 * (Android, iPhone/iPad, application de bureau). Surcharge : `EXPO_PUBLIC_INSTALL_URL`.
 */
export const INSTALL_GUIDE_URL: string = envInstallUrl ?? '/install';
