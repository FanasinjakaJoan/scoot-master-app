import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { AppState, Platform } from 'react-native';
import { useNetworkState } from 'expo-network';

import { secureGet, secureSet, secureDelete } from '../lib/secureStorage';
import { needsRefresh, jwtExpiresAt } from '../lib/jwt';

import { login as apiLogin, refreshTokenSafe as apiRefreshSafe, updateMyProfile as apiUpdateMyProfile, ApiError } from '../data/api/client';
import * as repo from '../data/local/repositories';
import {
  runSyncCycle, readSyncStatus, clearAuthSuspension, resolveConflictKeepServer, resolveConflictForceMine,
  retryFailedOperation, exportLocal, localBackupSpec, uploadLocalBackup,
  readFirebaseBackupStatus, triggerFirebaseBackup, restoreFirebase, listFirebaseBackups,
} from '../data/sync/engine';
import type { SyncSessionKeeper } from '../data/sync/engine';
import type { FirebaseBackupRun, FirebaseBackupStatus } from '../data/api/client';
import { Alert } from '../lib/alert';
import { deviceIdBase, uuid } from '../lib/uuid';
import { APP_NAME } from '../lib/config';
import type {
  Bike, BikeStatus, Customer, Sale, SaleStatus, SyncStatus, User,
} from '../types';

/**
 * Store global de l'app : session permanente, réseau, moteur de synchronisation.
 *
 * NOUVELLE STRATÉGIE (session permanente) :
 * - La session ne prend fin QUE sur déconnexion explicite (bouton « Se déconnecter »).
 * - Un 401/403 pendant sync (push/pull) est traité comme une interruption réseau
 *   temporaire : on garde les données en attente et on re-tente au prochain cycle.
 * - Au démarrage, on valide uniquement la présence du jeton en local — pas de
 *   blocage si le serveur est injoignable ou refuse.
 * - Renouvellement silencieux en arrière-plan (jeton 1 an, keep-alive 15 min).
 * - Aucune suppression automatique du stockage local (SecureStore/localStorage)
 *   en dehors de logout().
 */

const TOKEN_KEY = 'sm_token';
const USER_KEY = 'sm_user';

type RenewOutcome =
  | { status: 'renewed'; token: string }
  | { status: 'unavailable' };

interface AppContextValue {
  user: User | null;
  token: string | null;
  online: boolean;
  authNotice: string | null;
  doLogin: (username: string, password: string) => Promise<void>;
  doLogout: () => Promise<void>;
  sessionExpired: (reason?: string) => Promise<void>;
  updateProfile: (fullName: string, password?: string) => Promise<void>;
  sync: SyncStatus;
  scheduleSync: (delayMs?: number) => void;
  resolveConflict: (queueId: number, keepServer: boolean) => Promise<void>;
  retryFailed: (queueId: number) => void;
  saveBike: (input: Partial<Bike> & { id: string }) => void;
  patchBike: (id: string, patch: Partial<Bike>) => void;
  deleteBike: (id: string) => void;
  saveCustomer: (input: Partial<Customer> & { id: string }) => void;
  deleteCustomer: (id: string) => void;
  saveSale: (input: Parameters<typeof repo.saveSale>[0]) => Sale;
  patchSaleStatus: (id: string, status: SaleStatus) => void;
  deleteSale: (id: string) => void;
  shareExport: (entity: 'bikes' | 'customers' | 'sales', format: 'json' | 'csv') => Promise<void>;
  shareFullBackup: () => Promise<void>;
  uploadBackup: () => Promise<string>;
  /** Sauvegarde Firebase : état courant (admin). */
  firebaseBackupStatus: () => Promise<FirebaseBackupStatus>;
  /** Sauvegarde Firebase : déclenchement immédiat (admin). */
  backupNow: () => Promise<FirebaseBackupRun>;
  /** Sauvegarde Firebase : fichiers disponibles pour restauration (admin). */
  listBackups: () => Promise<{ path: string; size: number; updatedAt: string | null }[]>;
  /** Sauvegarde Firebase : restauration d'un fichier précis (admin). */
  restoreBackup: (path: string) => Promise<Record<string, number>>;
  dataVersion: number;
  refresh: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [sync, setSync] = useState<SyncStatus>({
    syncing: false, lastSyncAt: null, lastError: null, authRequired: false,
    pendingCount: 0, conflictCount: 0, failedCount: 0,
  });

  const network = useNetworkState();
  const online = network.isConnected !== false;

  const tokenRef = useRef(token);
  const userRef = useRef(user);
  const onlineRef = useRef(online);
  const syncingRef = useRef(false);
  const deviceIdRef = useRef<string>('');
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renewInFlight = useRef<Promise<RenewOutcome> | null>(null);
  const doSyncRef = useRef<() => Promise<void>>(async () => {});
  const expiresAtRef = useRef<number | null>(null);
  const keepAliveTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateSub = useRef<ReturnType<typeof AppState.addEventListener> | null>(null);
  tokenRef.current = token;
  userRef.current = user;
  onlineRef.current = online;

  // ---- session permanente : plus d'expiration automatique ----
  /**
   * Ancienne fonction d'expiration automatique — désormais NO-OP pour respecter
   * la règle « déconnexion explicite exclusive ». On garde la signature pour
   * compatibilité mais on NE supprime PLUS le jeton. Seul doLogout() supprime.
   * On affiche éventuellement une notice non bloquante.
   */
  const sessionExpired = useCallback(async (reason?: string) => {
    // Ne plus supprimer le stockage local — on garde l'utilisateur connecté.
    // On se contente d'une notice informative si fournie, sans déconnecter.
    if (reason) {
      // eslint-disable-next-line no-console
      console.log('[Session] notice (non bloquante, session conservée):', reason);
    }
    setAuthNotice(null);
    // On ne touche pas à token/user, on ne supprime pas SecureStore.
    // Le sync reste en attente et retentera.
    setSync((s) => ({ ...s, syncing: false, authRequired: false }));
  }, []);

  // ---- chargement de session au démarrage : uniquement présence locale ----
  useEffect(() => {
    (async () => {
      try {
        const t = await secureGet(TOKEN_KEY);
        const u = await secureGet(USER_KEY);
        if (t && u) {
          // Session permanente : on restaure dès que présent en local,
          // sans vérifier auprès du serveur, sans bloquer si serveur injoignable.
          try {
            setToken(t);
            setUser(JSON.parse(u) as User);
          } catch {
            // Données utilisateur corrompues : on garde quand même le token,
            // l'utilisateur reste connecté, profil à recharger au prochain login.
            setToken(t);
          }
        }
      } catch { /* première installation */ }
      let did = repo.metaGet('device_id');
      if (!did) {
        did = deviceIdBase();
        repo.metaSet('device_id', did);
      }
      deviceIdRef.current = did;
      setSync(readSyncStatus());
    })();
  }, []);

  const refresh = useCallback(() => setDataVersion((v) => v + 1), []);

  const persistSession = useCallback(async (nextToken: string, nextUser: User, expiresAt?: number) => {
    await secureSet(TOKEN_KEY, nextToken);
    await secureSet(USER_KEY, JSON.stringify(nextUser));
    expiresAtRef.current = expiresAt ?? jwtExpiresAt(nextToken);
    tokenRef.current = nextToken;
    userRef.current = nextUser;
    setToken(nextToken);
    setUser(nextUser);
  }, []);

  // ---- renouvellement silencieux (toujours 200, jamais de déconnexion) ----
  const renewSession = useCallback(async (): Promise<RenewOutcome> => {
    if (renewInFlight.current) return renewInFlight.current;
    const run = (async (): Promise<RenewOutcome> => {
      const current = tokenRef.current || (await secureGet(TOKEN_KEY).catch(() => null));
      if (!current || !onlineRef.current) return { status: 'unavailable' };
      try {
        const res = await apiRefreshSafe(current);
        if (res.valid && res.token && res.user) {
          await persistSession(res.token, {
            id: res.user.id,
            username: res.user.username,
            fullName: res.user.fullName,
            role: res.user.role as User['role'],
          }, res.expiresAt);
          return { status: 'renewed', token: res.token };
        }
        // Même si valid:false (révoqué, expiré hors grâce, signature invalide),
        // on GARDE l'utilisateur connecté en local — pas de déconnexion auto.
        return { status: 'unavailable' };
      } catch {
        // Échec réseau / serveur en veille / 5xx : on garde la session.
        return { status: 'unavailable' };
      }
    })();
    renewInFlight.current = run;
    try {
      return await run;
    } finally {
      if (renewInFlight.current === run) renewInFlight.current = null;
    }
  }, [persistSession]);

  const sessionKeeper = useMemo<SyncSessionKeeper>(() => ({
    refreshSession: async () => {
      const r = await renewSession();
      // Toujours traiter comme transitoire si non renouvelé — jamais de refus définitif.
      return r.status === 'renewed'
        ? { ok: true as const, token: r.token }
        : { ok: false as const, refused: false };
    },
  }), [renewSession]);

  // ---- jeton : lecture locale + renouvellement silencieux non bloquant ----
  const ensureFreshToken = useCallback(async (): Promise<string | null> => {
    let current = tokenRef.current;
    try {
      const stored = await secureGet(TOKEN_KEY);
      if (stored) current = stored;
    } catch { /* stockage indisponible : on tente l'état courant */ }
    if (!current) return null;

    // Renouvellement silencieux si proche de l'échéance — sans bloquer l'UI,
    // sans déconnecter en cas d'échec.
    if (needsRefresh(current)) {
      if (!onlineRef.current) return current;
      const outcome = await renewSession();
      if (outcome.status === 'renewed') return outcome.token;
      // Échec : on garde le jeton courant, l'utilisateur reste connecté.
      return current;
    }
    return current;
  }, [renewSession]);

  const retryPendingBackupUpload = useCallback(async (): Promise<boolean> => {
    if (repo.metaGet('pending_backup_upload') !== '1') return false;
    const fresh = await ensureFreshToken();
    if (!fresh) return false;
    try {
      const spec = localBackupSpec();
      await uploadLocalBackup(fresh, spec.fileName, sessionKeeper);
      Alert.alert('Sauvegarde envoyée', `Votre sauvegarde en attente a été téléversée sur le serveur : ${spec.fileName}`);
      return true;
    } catch {
      return false;
    }
  }, [ensureFreshToken, sessionKeeper]);

  const scheduleSync = useCallback((delayMs = 800) => {
    if (!tokenRef.current || !onlineRef.current || syncingRef.current) return;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      syncTimer.current = null;
      void doSyncRef.current();
    }, delayMs);
  }, []);

  // ---- cycle de synchronisation : 401/403 = interruption temporaire, pas de déconnexion ----
  const doSync = useCallback(async () => {
    if (syncingRef.current || !onlineRef.current) return;
    const freshToken = await ensureFreshToken();
    if (!freshToken) {
      setSync((s) => ({ ...s, syncing: false }));
      return;
    }
    syncingRef.current = true;
    setSync((s) => ({ ...s, syncing: true, lastError: null, authRequired: false }));
    const outcome = await runSyncCycle(freshToken, deviceIdRef.current, sessionKeeper);
    syncingRef.current = false;
    if (outcome.pushed > 0 || outcome.pulled > 0) setDataVersion((v) => v + 1);
    setSync({ ...readSyncStatus(), syncing: false, authRequired: false });
    if (outcome.authRequired) {
      // NOUVELLE RÈGLE : 401/403 pendant sync = interruption réseau temporaire.
      // On garde les données en attente localement et on re-tente au prochain cycle.
      // Pas de message "session expirée", pas de déconnexion, pas d'authRequired.
      scheduleSync(30000);
      return;
    }
    if (outcome.error && outcome.pushed === 0 && outcome.pulled === 0) {
      setSync((s) => ({ ...s, lastError: outcome.error || null, authRequired: false }));
    }
  }, [ensureFreshToken, sessionKeeper, scheduleSync]);

  useEffect(() => {
    doSyncRef.current = doSync;
  }, [doSync]);

  useEffect(() => {
    if (online && token) scheduleSync(1200);
  }, [online, token, scheduleSync]);

  useEffect(() => {
    const onState = (state: string) => {
      if (state !== 'active') return;
      void ensureFreshToken();
      scheduleSync(600);
    };
    const sub = AppState.addEventListener('change', onState);
    appStateSub.current = sub;
    return () => sub.remove();
  }, [scheduleSync, ensureFreshToken]);

  useEffect(() => {
    if (!token) {
      if (keepAliveTimer.current) {
        clearInterval(keepAliveTimer.current);
        keepAliveTimer.current = null;
      }
      return;
    }
    const KEEP_ALIVE_MS = 15 * 60 * 1000;
    keepAliveTimer.current = setInterval(() => { void ensureFreshToken(); }, KEEP_ALIVE_MS);
    return () => {
      if (keepAliveTimer.current) clearInterval(keepAliveTimer.current);
      keepAliveTimer.current = null;
    };
  }, [token, ensureFreshToken]);

  // ---- session ----
  const doLogin = useCallback(async (username: string, password: string) => {
    const res = await apiLogin(username, password);
    const u: User = { id: res.user.id, username: res.user.username, fullName: res.user.fullName, role: res.user.role as User['role'] };
    await persistSession(res.token, u, res.expiresAt);
    setAuthNotice(null);
    clearAuthSuspension();
    setSync(readSyncStatus());
    scheduleSync(500);
    void retryPendingBackupUpload();
  }, [scheduleSync, retryPendingBackupUpload, persistSession]);

  const updateProfile = useCallback(async (fullName: string, password?: string) => {
    const fresh = await ensureFreshToken();
    if (!fresh || !userRef.current) throw new ApiError(401, 'Session expirée — reconnectez-vous.');
    const applyProfile = async (res: { user: { fullName: string } }) => {
      if (!userRef.current) return;
      const next: User = { ...userRef.current, fullName: res.user.fullName };
      await secureSet(USER_KEY, JSON.stringify(next));
      userRef.current = next;
      setUser(next);
    };
    try {
      const res = await apiUpdateMyProfile(fresh, { fullName, ...(password ? { password } : {}) });
      await applyProfile(res);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        const healed = await renewSession();
        if (healed.status === 'renewed') {
          const res = await apiUpdateMyProfile(healed.token, { fullName, ...(password ? { password } : {}) });
          await applyProfile(res);
          return;
        }
        // Échec même après tentative de refresh : on garde la session locale,
        // on informe l'utilisateur que c'est une interruption temporaire.
        throw new ApiError(e.status, 'Mise à jour en attente — connexion temporairement indisponible, réessayez.');
      }
      throw e;
    }
  }, [ensureFreshToken, renewSession]);

  /** Déconnexion volontaire : SEUL cas où la session est fermée côté client. */
  const doLogout = useCallback(async () => {
    await secureDelete(TOKEN_KEY);
    await secureDelete(USER_KEY);
    setToken(null);
    tokenRef.current = null;
    setUser(null);
    userRef.current = null;
    expiresAtRef.current = null;
    setAuthNotice(null);
    setSync((s) => ({ ...s, syncing: false, authRequired: false }));
  }, []);

  // ---- mutations locales ----
  const actor = useCallback(() => ({ userId: user?.id || 'local', deviceId: deviceIdRef.current || 'local' }), [user]);

  const saveBike = useCallback((input: Partial<Bike> & { id: string }) => {
    repo.saveBike(input, actor());
    refresh();
    scheduleSync();
  }, [actor, refresh, scheduleSync]);

  const patchBike = useCallback((id: string, patch: Partial<Bike>) => {
    repo.patchBike(id, patch, actor());
    refresh();
    scheduleSync();
  }, [actor, refresh, scheduleSync]);

  const deleteBike = useCallback((id: string) => {
    repo.deleteBike(id, actor());
    refresh();
    scheduleSync();
  }, [actor, refresh, scheduleSync]);

  const saveCustomer = useCallback((input: Partial<Customer> & { id: string }) => {
    repo.saveCustomer(input, actor());
    refresh();
    scheduleSync();
  }, [actor, refresh, scheduleSync]);

  const deleteCustomer = useCallback((id: string) => {
    repo.deleteCustomer(id, actor());
    refresh();
    scheduleSync();
  }, [actor, refresh, scheduleSync]);

  const saveSale = useCallback((input: Parameters<typeof repo.saveSale>[0]) => {
    const s = repo.saveSale(input, actor());
    refresh();
    scheduleSync();
    return s;
  }, [actor, refresh, scheduleSync]);

  const patchSaleStatus = useCallback((id: string, status: SaleStatus) => {
    repo.patchSaleStatus(id, status, actor());
    refresh();
    scheduleSync();
  }, [actor, refresh, scheduleSync]);

  const deleteSale = useCallback((id: string) => {
    repo.deleteSale(id, actor());
    refresh();
    scheduleSync();
  }, [actor, refresh, scheduleSync]);

  const resolveConflict = useCallback(async (queueId: number, keepServer: boolean) => {
    if (keepServer) {
      resolveConflictKeepServer(queueId);
    } else {
      if (!onlineRef.current) throw new ApiError(0, 'Connexion requise pour forcer.');
      const fresh = await ensureFreshToken();
      if (!fresh) throw new ApiError(401, 'Session expirée — reconnectez-vous.');
      await resolveConflictForceMine(fresh, deviceIdRef.current, queueId, user as User, sessionKeeper);
    }
    refresh();
    setSync(readSyncStatus());
  }, [refresh, user, ensureFreshToken, sessionKeeper]);

  const retryFailed = useCallback((queueId: number) => {
    retryFailedOperation(queueId);
    setSync(readSyncStatus());
    scheduleSync(300);
  }, [scheduleSync]);

  const writeAndShare = useCallback(async (fileName: string, content: string, mime: string) => {
    if (Platform.OS === 'web') {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return;
    }
    const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system');
    const Sharing = require('expo-sharing') as typeof import('expo-sharing');
    const file = new File(Paths.document, fileName);
    file.write(content);
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: `Exporter ${fileName}` });
    } else {
      AlertInfo(`Fichier enregistré : ${file.uri}`);
    }
  }, []);

  const shareExport = useCallback(async (entity: 'bikes' | 'customers' | 'sales', format: 'json' | 'csv') => {
    const spec = exportLocal(entity, format);
    await writeAndShare(spec.fileName, spec.content, spec.mime);
  }, [writeAndShare]);

  const shareFullBackup = useCallback(async () => {
    const spec = localBackupSpec();
    await writeAndShare(spec.fileName, spec.content, spec.mime);
  }, [writeAndShare]);

  const uploadBackup = useCallback(async () => {
    const fresh = await ensureFreshToken();
    if (!fresh) throw new ApiError(401, 'Session expirée — reconnectez-vous : la sauvegarde sera re-téléversée automatiquement après.');
    try {
      const spec = localBackupSpec();
      return await uploadLocalBackup(fresh, spec.fileName, sessionKeeper);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        throw new ApiError(e.status, 'Sauvegarde en attente — interruption temporaire, réessai automatique.');
      }
      throw e;
    }
  }, [ensureFreshToken, sessionKeeper]);

  /** Récupère un jeton frais ou signale que la sauvegarde Firebase est impossible. */
  const requireFreshToken = useCallback(async () => {
    const fresh = await ensureFreshToken();
    if (!fresh) throw new ApiError(401, 'Session expirée — reconnectez-vous pour lancer la sauvegarde Firebase.');
    return fresh;
  }, [ensureFreshToken]);

  const firebaseBackupStatus = useCallback(
    async () => readFirebaseBackupStatus(await requireFreshToken(), sessionKeeper),
    [requireFreshToken, sessionKeeper]
  );

  const backupNow = useCallback(() => (async () => {
    const run = await triggerFirebaseBackup(await requireFreshToken(), sessionKeeper);
    if (run.status === 'failure') {
      throw new Error(run.error || 'La sauvegarde Firebase a échoué.');
    }
    return run;
  })(), [requireFreshToken, sessionKeeper]);

  const restoreBackup = useCallback((path: string) => (async () => {
    const result = await restoreFirebase(await requireFreshToken(), path, sessionKeeper);
    // La base locale vient de changer : forcer le rafraîchissement des écrans.
    setDataVersion((v) => v + 1);
    return result.applied;
  })(), [requireFreshToken, sessionKeeper]);

  const listBackups = useCallback(
    async () => listFirebaseBackups(await requireFreshToken(), sessionKeeper),
    [requireFreshToken, sessionKeeper]
  );

  const value = useMemo<AppContextValue>(() => ({
    user, token, online, authNotice,
    doLogin, doLogout, sessionExpired, updateProfile,
    sync, scheduleSync,
    resolveConflict, retryFailed,
    saveBike, patchBike, deleteBike,
    saveCustomer, deleteCustomer,
    saveSale, patchSaleStatus, deleteSale,
    shareExport, shareFullBackup, uploadBackup,
    firebaseBackupStatus, backupNow, restoreBackup, listBackups,
    dataVersion, refresh,
  }), [user, token, online, authNotice, doLogin, doLogout, sessionExpired, updateProfile, sync, scheduleSync, resolveConflict, retryFailed,
    saveBike, patchBike, deleteBike, saveCustomer, deleteCustomer, saveSale, patchSaleStatus,
    deleteSale, shareExport, shareFullBackup, uploadBackup,
    firebaseBackupStatus, backupNow, restoreBackup, listBackups,
    dataVersion, refresh]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function AlertInfo(message: string): void {
  // eslint-disable-next-line no-console
  console.log(APP_NAME + ' — ' + message);
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp doit être utilisé dans <AppProvider>');
  return ctx;
}

export function useBikes(filter: {
  status?: BikeStatus | string; brand?: string; q?: string;
  minPrice?: number; maxPrice?: number; sort?: string; order?: 'asc' | 'desc';
} = {}): Bike[] {
  const { dataVersion } = useApp();
  const [rows, setRows] = useState<Bike[]>([]);
  useEffect(() => {
    setRows(repo.listBikes(filter as Parameters<typeof repo.listBikes>[0]));
  }, [dataVersion, filter.status, filter.brand, filter.q, filter.minPrice, filter.maxPrice, filter.sort, filter.order]);
  return rows;
}

export function useCustomers(q?: string): Customer[] {
  const { dataVersion } = useApp();
  const [rows, setRows] = useState<Customer[]>([]);
  useEffect(() => { setRows(repo.listCustomers(q)); }, [dataVersion, q]);
  return rows;
}

export function useSales(filter: { status?: SaleStatus | string; customerId?: string } = {}): Sale[] {
  const { dataVersion } = useApp();
  const [rows, setRows] = useState<Sale[]>([]);
  useEffect(() => { setRows(repo.listSales(filter as Parameters<typeof repo.listSales>[0])); },
    [dataVersion, filter.status, filter.customerId]);
  return rows;
}

export function useDashboard() {
  const { dataVersion, sync } = useApp();
  const [stats, setStats] = useState<ReturnType<typeof repo.dashboardStats> | null>(null);
  useEffect(() => { setStats(repo.dashboardStats()); }, [dataVersion]);
  return { ...stats, sync };
}

export function newEntityId(): string {
  return uuid();
}
