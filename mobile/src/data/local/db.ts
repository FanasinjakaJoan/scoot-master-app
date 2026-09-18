import * as SQLite from 'expo-sqlite';

import { SCHEMA } from './schema';

/**
 * Base SQLite locale (persistance hors ligne) — implémentation NATIVE.
 *
 * Miroir du schéma serveur + tables de synchronisation (queue, conflits, méta).
 * Toutes les écritures passent par les repositories (src/data/local/repositories.ts).
 *
 * En natif (iOS / Android), `expo-sqlite` ouvre la base de façon synchrone :
 * l'API `…Sync` est disponible immédiatement, `initLocalDb()` n'a donc rien à
 * faire. Dans le navigateur, c'est `db.web.ts` qui remplace ce module
 * (Metro résout `./db` → `db.web.ts` sur la cible web) avec une ouverture
 * asynchrone du moteur SQLite/WASM.
 *
 * ⚠️ Ne pas utiliser `openDatabaseSync` côté web : l'implémentation web
 * d'`expo-sqlite` passe par un Worker + `SharedArrayBuffer`, ce qui exige un
 * contexte « crossOriginIsolated » (en-têtes COOP/COEP) et un bundle de Worker —
 * conditions impossibles à garantir (aperçu intégré, export statique), d'où une
 * page blanche. Voir `db.web.ts`.
 */
export const localDb: SQLite.SQLiteDatabase = SQLite.openDatabaseSync('scootmaster.db');

localDb.execSync(SCHEMA);

export { SCHEMA, nowIso } from './schema';

/**
 * Point d'initialisation asynchrone appelé avant le rendu de l'application.
 * No-op en natif (base déjà ouverte), nécessaire sur web.
 */
export async function initLocalDb(): Promise<void> {
  // Rien à faire : l'ouverture synchrone a déjà été effectuée à l'import.
}

/** Force la persistance de l'état courant (no-op en natif, SQLite écrit en direct). */
export async function flushLocalDb(): Promise<void> {
  // natif : les écritures sont déjà durables
}
