import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { AppState, Platform } from 'react-native';
import { useNetworkState } from 'expo-network';
import * as SecureStore from 'expo-secure-store';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { login as apiLogin, ApiError } from '../data/api/client';
import * as repo from '../data/local/repositories';
import {
  runSyncCycle, readSyncStatus, resolveConflictKeepServer, resolveConflictForceMine,
  retryFailedOperation, exportLocal, localBackupSpec, uploadLocalBackup,
} from '../data/sync/engine';
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
  doLogin: (username: string, password: string) => Promise<void>;
  doLogout: () => Promise<void>;
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
  const [dataVersion, setDataVersion] = useState(0);
  const [sync, setSync] = useState<SyncStatus>({
    syncing: false, lastSyncAt: null, lastError: null,
    pendingCount: 0, conflictCount: 0, failedCount: 0,
  });

  const network = useNetworkState();
  const online = network.isConnected !== false;

  const tokenRef = useRef(token);
  const onlineRef = useRef(online);
  const syncingRef = useRef(false);
  const deviceIdRef = useRef<string>('');
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appStateSub = useRef<ReturnType<typeof AppState.addEventListener> | null>(null);
  tokenRef.current = token;
  onlineRef.current = online;

  // ---- chargement de session ----
  useEffect(() => {
    (async () => {
      try {
        const t = await SecureStore.getItemAsync(TOKEN_KEY);
        const u = await SecureStore.getItemAsync(USER_KEY);
        if (t && u) {
          setToken(t);
          setUser(JSON.parse(u) as User);
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

  // ---- cycle de synchronisation ----
  const doSync = useCallback(async () => {
    if (syncingRef.current || !tokenRef.current || !onlineRef.current) return;
    syncingRef.current = true;
    setSync((s) => ({ ...s, syncing: true, lastError: null }));
    const outcome = await runSyncCycle(tokenRef.current as string, deviceIdRef.current);
    if (outcome.error && outcome.pushed === 0 && outcome.pulled === 0) {
      setSync((s) => ({ ...s, lastError: outcome.error || null }));
    }
    syncingRef.current = false;
    if (outcome.pushed > 0 || outcome.pulled > 0) setDataVersion((v) => v + 1);
    setSync(readSyncStatus());
  }, []);

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
    await SecureStore.setItemAsync(TOKEN_KEY, res.token);
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(res.user));
    setToken(res.token);
    setUser({ id: res.user.id, username: res.user.username, fullName: res.user.fullName, role: res.user.role as User['role'] });
    setSync(readSyncStatus());
    scheduleSync(500);
  }, [scheduleSync]);

  const doLogout = useCallback(async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(USER_KEY);
    setToken(null);
    setUser(null);
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
    if (!tokenRef.current) throw new ApiError(0, 'Non connecté.');
    const spec = localBackupSpec();
    return uploadLocalBackup(tokenRef.current, spec.fileName);
  }, []);

  const value = useMemo<AppContextValue>(() => ({
    user, token, online,
    doLogin, doLogout,
    sync, scheduleSync,
    resolveConflict, retryFailed,
    saveBike, patchBike, deleteBike,
    saveCustomer, deleteCustomer,
    saveSale, patchSaleStatus, deleteSale,
    shareExport, shareFullBackup, uploadBackup,
    dataVersion, refresh,
  }), [user, token, online, doLogin, doLogout, sync, scheduleSync, resolveConflict, retryFailed,
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
