import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
// Asset WASM fourni par Metro (metro.config.js : `assetExts` inclut `wasm`).
// Cible web ⇒ l'import renvoie l'URL de l'asset ; ailleurs `{ uri }` (toléré).
import wasmAssetUrl from 'sql.js/dist/sql-wasm.wasm';

import { SCHEMA, migrateLocalSchema } from './schema';
import { rowsFromQueryResults, toBindValues } from './sqlite-values';

/**
 * Base SQLite locale — implémentation NAVIGATEUR.
 *
 * `expo-sqlite` n'est pas utilisable dans un navigateur pour ce besoin : son
 * adaptation web passe par un `Worker` couplé à un `SharedArrayBuffer`, donc un
 * contexte *crossOriginIsolated* (en-têtes COOP/COEP) et un bundle de Worker
 * dédié. Sans ces conditions — aperçu intégré dans une iframe, export
 * statique, navigateur en mode privé — l'ouverture synchrone de la base lève
 * une exception dès l'évaluation du module : l'application restait sur une page
 * blanche.
 *
 * Ici SQLite (mêmes capacités SQL que la base native) tourne sur le thread
 * principal grâce à `sql.js`, **de façon synchrone** : repositories et moteur
 * de synchronisation restent donc strictement identiques sur les deux cibles.
 * La durabilité est assurée par un instantané du fichier SQLite, écrit en
 * IndexedDB après chaque transaction (repli `localStorage`).
 */

export { SCHEMA, nowIso } from './schema';

const DB_KEY = 'scootmaster.db';
const IDB_NAME = 'scoot-master';
const IDB_STORE = 'sqlite';
/** Report des écritures disque (les lectures sont, elles, toujours à jour). */
const PERSIST_DEBOUNCE_MS = 150;
/** Garde-fou du repli localStorage (quota d'environ 4 Mo par origine). */
const LOCALSTORAGE_MAX_BYTES = 2_500_000;

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------
// Persistance de l'instantané SQLite (IndexedDB, repli localStorage)
// ---------------------------------------------------------------------

function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) request.result.createObjectStore(IDB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB indisponible.'));
  });
}

async function idbWrite(bytes: Uint8Array): Promise<void> {
  const database = await openIdb();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(IDB_STORE, 'readwrite');
    transaction.objectStore(IDB_STORE).put(bytes, DB_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error('Échec de l’écriture IndexedDB.'));
    };
  });
}

async function idbRead(): Promise<Uint8Array | null> {
  const database = await openIdb();
  return new Promise<Uint8Array | null>((resolve, reject) => {
    const transaction = database.transaction(IDB_STORE, 'readonly');
    const request = transaction.objectStore(IDB_STORE).get(DB_KEY);
    request.onsuccess = () => {
      database.close();
      resolve(request.result instanceof Uint8Array ? request.result : null);
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error('Échec de la lecture IndexedDB.'));
    };
  });
}

/** Base64 par blocs : `btoa` fatigue sur les gros tableaux binaires. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readSnapshot(): Promise<Uint8Array | null> {
  try {
    if (indexedDbAvailable()) {
      const bytes = await idbRead();
      if (bytes) return bytes;
    }
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DB_KEY) : null;
    return raw ? base64ToBytes(raw) : null;
  } catch {
    return null; // stockage indisponible : base en mémoire pour la session
  }
}

async function writeSnapshot(bytes: Uint8Array): Promise<void> {
  if (indexedDbAvailable()) {
    try {
      await idbWrite(bytes);
      return;
    } catch {
      /* on tente le repli ci-dessous */
    }
  }
  try {
    if (typeof localStorage !== 'undefined' && bytes.length <= LOCALSTORAGE_MAX_BYTES) {
      localStorage.setItem(DB_KEY, bytesToBase64(bytes));
    }
  } catch {
    /* quota dépassé : les données restent valides pour la session */
  }
}

// ---------------------------------------------------------------------
// Adaptateur synchrone — surface compatible avec `SQLite.SQLiteDatabase`
// ---------------------------------------------------------------------

interface RunResult {
  lastInsertId: number;
  rowsAffected: number;
}

class WebSQLiteDatabase {
  private handle: Database | null = null;
  private txDepth = 0;
  private savepoints = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Les écritures disque sont sérialisées pour éviter d'entremêler les instantanés. */
  private pendingSave: Promise<void> = Promise.resolve();

  /** Charge le moteur, restaure l'instantané puis applique le schéma. */
  async initAsync(): Promise<void> {
    if (this.handle) return;
    const wasmUrl = typeof wasmAssetUrl === 'string' ? wasmAssetUrl : wasmAssetUrl?.uri;
    const engine: SqlJsStatic = await initSqlJs(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
    const snapshot = await readSnapshot();
    const database = new engine.Database(snapshot ?? undefined);
    database.run(SCHEMA);
    this.handle = database;
    // Base restaurée d'un instantané antérieur : on ajoute les colonnes nouvelles.
    migrateLocalSchema(this);
    this.watchLifecycle();
  }

  private watchLifecycle(): void {
    // Environnements sans DOM complet (tests) : la persistance différée reste
    // active, seul le report forcé à la fermeture de l'onglet est ignoré.
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const flush = () => {
      void this.flush();
    };
    window.addEventListener('pagehide', flush);
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
    }
  }

  private require(): Database {
    if (!this.handle) {
      throw new Error(
        'Base locale non initialisée : le moteur SQLite web doit être chargé par initLocalDb() avant tout accès.'
      );
    }
    return this.handle;
  }

  /** Instructions multiples sans paramètre (DDL, scripts). */
  execSync(source: string): void {
    this.require().run(source);
    this.markDirty();
  }

  /** Instruction d'écriture (une seule instruction quand il y a des paramètres). */
  runSync(source: string, ...params: unknown[]): RunResult {
    const database = this.require();
    const bound = toBindValues(params);
    if (bound.length) database.run(source, bound);
    else database.run(source);
    const rowsAffected = database.getRowsModified();
    let lastInsertId = 0;
    if (/^\s*insert\s/i.test(source)) {
      lastInsertId = Number(database.exec('SELECT last_insert_rowid() AS id')[0]?.values[0]?.[0] ?? 0);
    }
    this.markDirty();
    return { lastInsertId, rowsAffected };
  }

  getAllSync<T = Row>(source: string, ...params: unknown[]): T[] {
    const database = this.require();
    const bound = toBindValues(params);
    const results = bound.length ? database.exec(source, bound) : database.exec(source);
    return rowsFromQueryResults(results) as T[];
  }

  getFirstSync<T = Row>(source: string, ...params: unknown[]): T | null {
    return this.getAllSync<T>(source, ...params)[0] ?? null;
  }

  isInTransactionSync(): boolean {
    return this.txDepth > 0;
  }

  /**
   * Transaction — imbrication supportée via SAVEPOINT, comme
   * `SQLiteDatabase.withTransactionSync` : toute écriture est annulée en cas d'erreur.
   */
  withTransactionSync(task: () => void): void {
    const database = this.require();
    const nested = this.txDepth > 0;
    const savepoint = nested ? `sp_scoot_${++this.savepoints}` : null;
    if (nested) database.run(`SAVEPOINT ${savepoint}`);
    else database.run('BEGIN');
    this.txDepth++;

    try {
      task();
    } catch (error) {
      this.txDepth--;
      try {
        if (savepoint) database.run(`ROLLBACK TO ${savepoint}`);
        else database.run('ROLLBACK');
      } catch {
        /* l'erreur d'origine prime */
      }
      if (savepoint) database.run(`RELEASE ${savepoint}`);
      throw error;
    }

    this.txDepth--;
    if (savepoint) database.run(`RELEASE ${savepoint}`);
    else database.run('COMMIT');
    this.markDirty();
  }

  /** Écrit l'instantané courant sur le support persistant. */
  async flush(): Promise<void> {
    if (!this.handle) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const bytes = this.handle.export();
    const task = this.pendingSave.catch(() => undefined).then(() => writeSnapshot(bytes));
    this.pendingSave = task.catch(() => undefined);
    await task;
  }

  private markDirty(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
  }
}

const localDb = new WebSQLiteDatabase();

export { localDb };

let initPromise: Promise<void> | null = null;

/**
 * Initialisation asynchrone de la base locale web (moteur WASM + restauration
 * de l'instantané). Idempotente ; relançable après un échec (l'écran
 * « Initialisation impossible » propose Réessayer).
 */
export function initLocalDb(): Promise<void> {
  if (!initPromise) {
    initPromise = localDb.initAsync().catch((error: unknown) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

/** Force l'écriture immédiate de l'instantané (avant export ou fin de session). */
export async function flushLocalDb(): Promise<void> {
  await localDb.flush();
}
