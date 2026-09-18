/**
 * Raccourci d'installation de l'application.
 *
 * Trois façons d'« installer » Scoot Master, selon l'appareil :
 *  - **Navigateur Android** : invite d'installation PWA (`beforeinstallprompt`)
 *    → l'app apparaît dans le lanceur ; sinon téléchargement de l'**APK**.
 *  - **Navigateur de bureau** (Chrome / Edge / Opera) : même invite → crée une
 *    **application de bureau** (fenêtre dédiée, icône dans le menu Démarrer).
 *  - **iOS / iPadOS** (Safari) : pas d'invite programmatique → « Partager →
 *    Sur l'écran d'accueil ».
 *
 * Le module est importable côté natif (Android/iOS compilés) : aucun accès à
 * `window` n'a lieu à l'import, tout passe par `setupInstallPrompt()` qui est
 * un non-événement hors navigateur.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { APP_NAME } from './config';

/** Événement Chromium non standard, exposé par Chrome/Edge/Samsung Internet. */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallPlatform = 'ios' | 'android' | 'desktop';

export interface InstallState {
  /** Le navigateur peut afficher l'invite d'installation. */
  canPrompt: boolean;
  /** L'app tourne déjà dans une fenêtre installée. */
  installed: boolean;
}

export interface InstallPlan extends InstallState {
  platform: InstallPlatform;
  /** Libellé du bouton principal. */
  buttonLabel: string;
  /** Le bouton principal doit appeler `prompt()` (sinon : instructions). */
  actionable: boolean;
  /** Titre de la carte. */
  title: string;
  /** Aide contextuelle (procédure manuelle si aucune invite n'est disponible). */
  hint: string;
  /** Propose le téléchargement de l'APK (Android uniquement). */
  showApkLink: boolean;
}

/** Famille d'appareil déduite de l'User-Agent. */
export function detectPlatform(userAgent: string): InstallPlatform {
  const ua = userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  // iPadOS 13+ se présente comme un Mac : « Macintosh » + écran tactile.
  if (/Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|CriOS|Edg|OPR/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/**
 * Construit le plan d'installation affiché par la carte « Installer ».
 * Fonction pure : couverte par `__tests__/install.test.ts`.
 */
export function buildInstallPlan(input: {
  userAgent: string;
  canPrompt: boolean;
  installed: boolean;
}): InstallPlan {
  const platform = detectPlatform(input.userAgent);
  const { canPrompt, installed } = input;

  if (installed) {
    return {
      platform, canPrompt: false, installed: true, actionable: false,
      buttonLabel: 'Application installée',
      title: `${APP_NAME} est installée`,
      hint: 'Relancez-la depuis l’icône de l’écran d’accueil ou du menu des applications.',
      showApkLink: false,
    };
  }

  if (canPrompt) {
    return {
      platform, canPrompt: true, installed: false, actionable: true,
      buttonLabel: platform === 'desktop' ? 'Installer l’application de bureau' : 'Installer l’application',
      title: 'Installer Scoot Master',
      hint: platform === 'desktop'
        ? 'Ajoute Scoot Master au menu Démarrer et l’ouvre dans sa propre fenêtre, comme une application native.'
        : 'Ajoute Scoot Master à l’écran d’accueil : lancement plein écran, données locales conservées.',
      showApkLink: platform === 'android',
    };
  }

  if (platform === 'ios') {
    return {
      platform, canPrompt: false, installed: false, actionable: false,
      buttonLabel: 'Installer via Safari',
      title: 'Installer sur iPhone / iPad',
      hint: 'Dans Safari : bouton Partager ⭧ puis « Sur l’écran d’accueil ». Chrome iOS ne propose pas l’installation.',
      showApkLink: false,
    };
  }

  if (platform === 'android') {
    return {
      platform, canPrompt: false, installed: false, actionable: false,
      buttonLabel: 'Télécharger l’APK',
      title: 'Installer l’APK Android',
      hint: 'Téléchargez l’APK puis ouvrez-le (autorisez « sources inconnues »). ' +
        'Dans Chrome : menu ⋮ puis « Installer l’application ».',
      showApkLink: true,
    };
  }

  return {
    platform, canPrompt: false, installed: false, actionable: false,
    buttonLabel: 'Installer l’application',
    title: 'Installer Scoot Master sur ce PC',
    hint: 'Chrome / Edge : menu ⋮ puis « Installer Scoot Master… ». ' +
      'L’icône apparaît aussi dans la barre d’adresse.',
    showApkLink: false,
  };
}

// =====================================================================
// Pont navigateur (invite d'installation, manifeste, service worker)
// =====================================================================

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let state: InstallState = { canPrompt: false, installed: false };
const listeners = new Set<() => void>();
let setupDone = false;

function setState(next: InstallState): void {
  if (next.canPrompt === state.canPrompt && next.installed === state.installed) return;
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const isBrowser = (): boolean =>
  Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined';

/** L'app s'exécute-t-elle dans une fenêtre installée (PWA) ? */
function detectInstalled(): boolean {
  if (!isBrowser()) return false;
  const w = window as unknown as {
    navigator?: { standalone?: boolean };
    matchMedia?: (q: string) => { matches: boolean };
  };
  if (w.navigator?.standalone) return true;
  try {
    return Boolean(w.matchMedia?.('(display-mode: standalone)')?.matches);
  } catch {
    return false;
  }
}

/**
 * Ajoute `<link rel="manifest">`, le thème et l'icône Apple si absents.
 * L'export web d'Expo génère un `index.html` minimal : le manifeste est donc
 * déclaré ici (fourni par `mobile/public/manifest.webmanifest`), ce qui rend
 * l'app installable aussi bien en build exporté qu'en `expo start --web`.
 */
export function ensureWebAppManifest(): void {
  if (!isBrowser()) return;
  const head = document.head;

  if (!head.querySelector('link[rel="manifest"]')) {
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = '/manifest.webmanifest';
    head.appendChild(link);
  }
  if (!head.querySelector('meta[name="theme-color"]')) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#FF5A1F';
    head.appendChild(meta);
  }
  if (!head.querySelector('link[rel="apple-touch-icon"]')) {
    const apple = document.createElement('link');
    apple.rel = 'apple-touch-icon';
    apple.setAttribute('href', '/icons/apple-touch-icon.png');
    head.appendChild(apple);
  }
  if (!head.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
    const cap = document.createElement('meta');
    cap.name = 'apple-mobile-web-app-capable';
    cap.content = 'yes';
    head.appendChild(cap);
  }
}

/** Enregistre le service worker (cache hors ligne + critère d'installabilité). */
export function registerServiceWorker(): void {
  if (!isBrowser()) return;
  const nav = navigator as Navigator & { serviceWorker?: ServiceWorkerContainer };
  if (!nav.serviceWorker?.register) return; // jsdom / navigateur ancien
  nav.serviceWorker.register('/sw.js').catch(() => { /* non bloquant */ });
}

/**
 * Branche l'invite d'installation. Idempotent ; à appeler une fois au démarrage
 * (voir `App.tsx`). Sans effet hors navigateur.
 */
export function setupInstallPrompt(): void {
  if (setupDone || !isBrowser()) return;
  setupDone = true;

  ensureWebAppManifest();
  registerServiceWorker();
  setState({ canPrompt: false, installed: detectInstalled() });

  window.addEventListener('beforeinstallprompt', (event: Event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    setState({ canPrompt: true, installed: false });
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    setState({ canPrompt: false, installed: true });
  });
}

/** Déclenche l'invite d'installation du navigateur. */
export async function requestInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredPrompt) return 'unavailable';
  const prompt = deferredPrompt;
  deferredPrompt = null;
  await prompt.prompt();
  const choice = await prompt.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
  setState({ canPrompt: false, installed: choice.outcome === 'accepted' });
  return choice.outcome;
}

/**
 * Ouvre un lien (téléchargement d'APK, page d'installation) dans un nouvel
 * onglet — `Linking` n'est pas nécessaire pour une simple URL web.
 */
export function openExternal(url: string): void {
  if (!isBrowser()) return;
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** État d'installation réactif (canPrompt / installed). */
const NO_INSTALL: InstallState = { canPrompt: false, installed: false };

export function useInstallState(): InstallState {
  // Hors navigateur, l'état reste figé : l'application native est déjà installée.
  useEffect(() => {
    setupInstallPrompt();
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => NO_INSTALL
  );
}

/** Plan d'installation complet, prêt à afficher. */
export function useInstallPlan(): InstallPlan {
  const s = useInstallState();
  const ua = isBrowser() ? navigator.userAgent : '';
  return buildInstallPlan({ userAgent: ua, canPrompt: s.canPrompt, installed: s.installed });
}
