import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { AppState, Platform } from 'react-native';
import { useNetworkState } from 'expo-network';

import { secureGet, secureSet, secureDelete } from '../lib/secureStorage';
import { isTokenExpired, isTokenExpiringSoon } from '../lib/jwt';

import { login as apiLogin, refreshToken as apiRefreshToken, updateMyProfile as apiUpdateMyProfile, ApiError } from '../data/api/client';
import * as repo from '../data/local/repositories';
import {
  runSyncCycle, readSyncStatus, clearAuthSuspension, resolveConflictKeepServer, resolveConflictForceMine,
  retryFailedOperation, exportLocal, localBackupSpec, uploadLocalBackup,
} from '../data/sync/engine';
import { Alert } from '../lib/alert';
import { deviceIdBase, uuid } from '../lib/uuid';
import { APP_NAME } from '../lib/config';
import type {
  Bike, BikeStatus, Customer, Sale, SaleStatus, SyncStatus, User,
} from '../types';

/**
 * Store global de l'app : session, réseau, moteur de synchronisation et
 * version des données locales (les écrans se ré-interrogent via `dataVersion`).
 */

const TOKEN_KEY = 'sm_token';
const USER_KEY = 'sm_user';

interface AppContextValue {
  // session
  user: User | null;
  token: string | null;
  online: boolean;
  /** Message affiché sur l'écran de connexion après une expiration/invalidation de session. */
  authNotice: string | null;
  doLogin: (username: string, password: string) => Promise<void>;
  doLogout: () => Promise<void>;
  /** Session invalide (401 persistant) : préserve les données locales, redirige vers la connexion. */
  sessionExpired: (reason?: string) => Promise<void>;
  updateProfile: (fullName: string, password?: string) => Promise<void>;
  // sync
  sync: SyncStatus;
  scheduleSync: (delayMs?: number) => void;
  resolveConflict: (queueId: number, keepServer: boolean) => Promise<void>;
  retryFailed: (queueId: number) => void;
  // mutations locales (enfilées pour la synchro)
  saveBike: (input: Partial<Bike> & { id: string }) => void;
  patchBike: (id: string, patch: Partial<Bike>) => void;
  deleteBike: (id: string) => void;
  saveCustomer: (input: Partial<Customer> & { id: string }) => void;
  deleteCustomer: (id: string) => void;
  saveSale: (input: Parameters<typeof repo.saveSale>[0]) => Sale;
  patchSaleStatus: (id: string, status: SaleStatus) => void;
  deleteSale: (id: string) => void;
  // exports
  shareExport: (entity: 'bikes' | 'customers' | 'sales', format: 'json' | 'csv') => Promise<void>;
  shareFullBackup: () => Promise<void>;
  uploadBackup: () => Promise<string>;
  // data
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
  const appStateSub = useRef<ReturnType<typeof AppState.addEventListener> | null>(null);
  tokenRef.current = token;
  userRef.current = user;
  onlineRef.current = online;

  // ---- session expirée / invalide (401 persistant) ----
  /**
   * Invalide la session SANS toucher aux données locales : la base SQLite et la
   * file de synchronisation sont intégralement conservées ; l'utilisateur est
   * redirigé vers la connexion avec une explication, et la transmission
   * reprendra dès la reconnexion (jeton valide réinjecté).
   */
  const sessionExpired = useCallback(async (reason?: string) => {
    await secureDelete(TOKEN_KEY);
    await secureDelete(USER_KEY);
    setToken(null);
    setUser(null);
    tokenRef.current = null;
    userRef.current = null;
    setAuthNotice(reason || 'Votre session a expiré. Reconnectez-vous — vos données locales sont conservées.');
    setSync({ ...readSyncStatus(), syncing: false });
  }, []);

  // ---- chargement de session ----
  useEffect(() => {
    (async () => {
      try {
        const t = await secureGet(TOKEN_KEY);
        const u = await secureGet(USER_KEY);
        if (t && u) {
          if (isTokenExpired(t)) {
            // Jeton périmé pendant la fermeture de l'app : réauthentification
            // immédiate — les données locales et la file restent intactes.
            await secureDelete(TOKEN_KEY);
            await secureDelete(USER_KEY);
            setAuthNotice('Votre session a expiré. Reconnectez-vous — vos données locales sont conservées.');
          } else {
            setToken(t);
            setUser(JSON.parse(u) as User);
          }
        }
      } catch { /* première installation */ }
      // identifiant d'appareil stable
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

  // ---- jeton : récupération depuis le stockage sécurisé + rafraîchissement ----
  /**
   * Lit le jeton dans le stockage local sécurisé (source de vérité) et le
   * renouvelle si nécessaire (expiration imminente). À exécuter AVANT chaque
   * transmission de fond : synchronisation automatique, téléversement de
   * sauvegarde. Renvoie un jeton utilisable, ou null si réauthentification
   * requise (l'utilisateur est alors redirigé proprement vers la connexion).
   */
  const ensureFreshToken = useCallback(async (): Promise<string | null> => {
    let current = tokenRef.current;
    try {
      const stored = await secureGet(TOKEN_KEY);
      if (stored) current = stored; // le stockage sécurisé prime sur l'état mémoire
    } catch { /* stockage indisponible : on tente l'état courant */ }
    if (!current) return null;
    if (isTokenExpired(current)) {
      await sessionExpired('Votre session a expiré. Reconnectez-vous — vos modifications en attente restent conservées.');
      return null;
    }
    if (isTokenExpiringSoon(current)) {
      try {
        const renewed = await apiRefreshToken(current);
        const u: User = { id: renewed.user.id, username: renewed.user.username, fullName: renewed.user.fullName, role: renewed.user.role as User['role'] };
        await secureSet(TOKEN_KEY, renewed.token);
        await secureSet(USER_KEY, JSON.stringify(u));
        tokenRef.current = renewed.token;
        userRef.current = u;
        setToken(renewed.token);
        setUser(u);
        return renewed.token;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          await sessionExpired();
          return null;
        }
        // Réseau indisponible ou incident passager : le jeton reste valable
        // jusqu'à sa vraie expiration ; on ne bloque pas la transmission.
        return current;
      }
    }
    return current;
  }, [sessionExpired]);

  /**
   * Re-tente le téléversement de la sauvegarde restée en attente après un
   * échec d'authentification — appelé après une reconnexion réussie (jeton
   * valide réinjecté). Ne supprime jamais la sauvegarde locale en cas d'échec.
   */
  const retryPendingBackupUpload = useCallback(async (): Promise<boolean> => {
    if (repo.metaGet('pending_backup_upload') !== '1') return false;
    const fresh = await ensureFreshToken();
    if (!fresh) return false;
    try {
      const spec = localBackupSpec();
      await uploadLocalBackup(fresh, spec.fileName);
      Alert.alert('Sauvegarde envoyée', `Votre sauvegarde en attente a été téléversée sur le serveur : ${spec.fileName}`);
      return true;
    } catch {
      return false; // reste en attente — re-tentative à la prochaine reconnexion
    }
  }, [ensureFreshToken]);

  // ---- cycle de synchronisation ----
  const doSync = useCallback(async () => {
    if (syncingRef.current || !onlineRef.current) return;
    // Le jeton est relu du stockage sécurisé et rafraîchi avant toute transmission.
    const freshToken = await ensureFreshToken();
    if (!freshToken) {
      setSync((s) => ({ ...s, syncing: false, authRequired: true }));
      return;
    }
    syncingRef.current = true;
    setSync((s) => ({ ...s, syncing: true, lastError: null }));
    const outcome = await runSyncCycle(freshToken, deviceIdRef.current);
    syncingRef.current = false;
    if (outcome.pushed > 0 || outcome.pulled > 0) setDataVersion((v) => v + 1);
    setSync({ ...readSyncStatus(), syncing: false });
    if (outcome.authRequired) {
      // 401/403 en pleine transmission (ex. expiration pendant un PUSH de fond) :
      // la file locale est intacte et marquée « suspendue pour raison d'auth » ;
      // on redirige proprement vers la connexion.
      await sessionExpired('Votre session a expiré pendant la synchronisation. Reconnectez-vous — vos modifications en attente restent conservées sur cet appareil.');
      return;
    }
    if (outcome.error && outcome.pushed === 0 && outcome.pulled === 0) {
      setSync((s) => ({ ...s, lastError: outcome.error || null }));
    }
  }, [ensureFreshToken, sessionExpired]);

  const scheduleSync = useCallback((delayMs = 800) => {
    if (!tokenRef.current || !onlineRef.current || syncingRef.current) return;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      syncTimer.current = null;
      void doSync();
    }, delayMs);
  }, [doSync]);

  // ---- déclencheurs automatiques ----
  useEffect(() => {
    if (online && token) scheduleSync(1200);
  }, [online, token, scheduleSync]);

  useEffect(() => {
    const onState = (state: string) => {
      if (state === 'active') scheduleSync(600);
    };
    const sub = AppState.addEventListener('change', onState);
    appStateSub.current = sub;
    return () => sub.remove();
  }, [scheduleSync]);

  // ---- session ----
  const doLogin = useCallback(async (username: string, password: string) => {
    const res = await apiLogin(username, password);
    await secureSet(TOKEN_KEY, res.token);
    await secureSet(USER_KEY, JSON.stringify(res.user));
    const u: User = { id: res.user.id, username: res.user.username, fullName: res.user.fullName, role: res.user.role as User['role'] };
    setToken(res.token);
    tokenRef.current = res.token;
    setUser(u);
    userRef.current = u;
    setAuthNotice(null); // la reconnexion soldant l'avis d'expiration
    // Jeton valide réinjecté : lève la suspension d'auth de la file —
    // les opérations conservées repartent dès le cycle ci-dessous.
    clearAuthSuspension();
    setSync(readSyncStatus());
    scheduleSync(500);
    // Re-tentative du téléversement de sauvegarde resté en attente (fond).
    void retryPendingBackupUpload();
  }, [scheduleSync, retryPendingBackupUpload]);

  const updateProfile = useCallback(async (fullName: string, password?: string) => {
    const fresh = await ensureFreshToken();
    if (!fresh || !userRef.current) throw new ApiError(401, 'Session expirée — reconnectez-vous.');
    try {
      // Endpoint auto-service `PATCH /api/users/profile` : accessible à tout
      // utilisateur authentifié pour SON profil (nom affiché, mot de passe).
      const res = await apiUpdateMyProfile(fresh, { fullName, ...(password ? { password } : {}) });
      const next: User = { ...userRef.current, fullName: res.user.fullName };
      await secureSet(USER_KEY, JSON.stringify(next));
      userRef.current = next;
      setUser(next);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        await sessionExpired();
        throw new ApiError(e.status, 'Session expirée — reconnectez-vous puis réessayez.');
      }
      throw e;
    }
  }, [ensureFreshToken, sessionExpired]);

  const doLogout = useCallback(async () => {
    await secureDelete(TOKEN_KEY);
    await secureDelete(USER_KEY);
    setToken(null);
    tokenRef.current = null;
    setUser(null);
    userRef.current = null;
    setAuthNotice(null);
    setSync((s) => ({ ...s, syncing: false }));
  }, []);

  // ---- mutations locales (source de vérité hors ligne) ----
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

  // ---- conflits ----
  const resolveConflict = useCallback(async (queueId: number, keepServer: boolean) => {
    if (keepServer) {
      resolveConflictKeepServer(queueId);
    } else {
      if (!tokenRef.current || !onlineRef.current) throw new ApiError(0, 'Connexion requise pour forcer.');
      await resolveConflictForceMine(tokenRef.current, deviceIdRef.current, queueId, user as User);
    }
    refresh();
    setSync(readSyncStatus());
  }, [refresh, user]);

  const retryFailed = useCallback((queueId: number) => {
    retryFailedOperation(queueId);
    setSync(readSyncStatus());
    scheduleSync(300);
  }, [scheduleSync]);

  // ---- exports / sauvegarde ----
  const writeAndShare = useCallback(async (fileName: string, content: string, mime: string) => {
    if (Platform.OS === 'web') {
      // Navigateur (PC / mobile) : téléchargement direct du fichier.
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
    // Natif : modules non-web chargés à la demande.
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
      return await uploadLocalBackup(fresh, spec.fileName);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        // Le drapeau `pending_backup_upload` est posé par uploadLocalBackup :
        // la sauvegarde repartira dès la reconnexion (jeton valide réinjecté).
        throw new ApiError(e.status, 'Session expirée — reconnectez-vous : la sauvegarde sera re-téléversée automatiquement après.');
      }
      throw e;
    }
  }, [ensureFreshToken]);

  const value = useMemo<AppContextValue>(() => ({
    user, token, online, authNotice,
    doLogin, doLogout, sessionExpired, updateProfile,
    sync, scheduleSync,
    resolveConflict, retryFailed,
    saveBike, patchBike, deleteBike,
    saveCustomer, deleteCustomer,
    saveSale, patchSaleStatus, deleteSale,
    shareExport, shareFullBackup, uploadBackup,
    dataVersion, refresh,
  }), [user, token, online, authNotice, doLogin, doLogout, sessionExpired, updateProfile, sync, scheduleSync, resolveConflict, retryFailed,
    saveBike, patchBike, deleteBike, saveCustomer, deleteCustomer, saveSale, patchSaleStatus,
    deleteSale, shareExport, shareFullBackup, uploadBackup, dataVersion, refresh]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function AlertInfo(message: string): void {
  // Petit utilitaire sans dépendance (l'UI utilisera des Alert dans les écrans)
  // eslint-disable-next-line no-console
  console.log(APP_NAME + ' — ' + message);
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp doit être utilisé dans <AppProvider>');
  return ctx;
}

// ---------------------------------------------------------------------
// Hooks de lecture locale (ré-interrogés à chaque version des données)
// ---------------------------------------------------------------------

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

/** Génère un UUID pour une nouvelle entité créée hors ligne. */
export function newEntityId(): string {
  return uuid();
}
