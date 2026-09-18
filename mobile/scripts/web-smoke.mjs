#!/usr/bin/env node
/**
 * Smoke test « navigateur » de l'application web (sans poste de test).
 *
 * Charge le build web (`npm run build:web`) réellement servi par le serveur
 * (`npm run serve:web`) dans un DOM simulé (jsdom), exécute le bundle, puis
 * vérifie que l'interface s'affiche et qu'aucune exception n'a été levée au
 * démarrage. C'est le garde-fou contre la « page blanche » : toute erreur levée
 * au chargement d'un module (moteur SQLite web, composant, navigation) fait
 * échouer ce test.
 *
 *   node scripts/web-smoke.mjs [url] [--expect texte] [--login u p] [--write] [--wait ms]
 *
 *   --expect <texte>   contenu attendu dans #root (défaut : « Scoot Master »)
 *   --login <u> <p>    se connecte via /api/auth/login (proxy du serveur web),
 *                      injecte la session puis attend l'accueil : valide ainsi
 *                      session restaurée + API + moteur de synchronisation (pull
 *                      des données de démo dans la base locale) + rendu écrans
 *   --write            ajoute une moto via le formulaire du catalogue (écriture
 *                      base locale + file de synchronisation) — à utiliser avec --login
 *   --wait <ms>        budget d'attente (défaut 8000, 25000 avec --login)
 *
 * Sortie : 0 = OK, 1 = échec.
 */

import { JSDOM, VirtualConsole } from 'jsdom';

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const takesTwo = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : [argv[i + 1], argv[i + 2]];
};
const consumed = new Set();
const mark = (name, count) => {
  const i = argv.indexOf(name);
  if (i !== -1) for (let k = 0; k <= count; k++) consumed.add(i + k);
};
mark('--expect', 1);
mark('--login', 2);
mark('--wait', 1);
mark('--write', 0);
const url = argv.find((a, i) => !consumed.has(i) && !a.startsWith('--')) || 'http://127.0.0.1:8080/';
const login = takesTwo('--login');
const write = argv.includes('--write');
const expectFlag = flagValue('--expect');
// Écran attendu :
//  - sans --login : l'écran de CONNEXION (et non l'écran de démarrage « Scoot
//    Master » qui porte le même logo — d'où « Se connecter », texte propre au
//    formulaire, pour éviter un faux positif tant que la base locale s'initialise) ;
//  - avec --login : l'accueil et ses statistiques (donc la base locale remplie
//    par le pull de synchronisation).
const expect = expectFlag ?? (login ? 'Motos disponibles' : 'Se connecter');

const waitMs = Number(flagValue('--wait') ?? (login ? 25000 : 8000));
const origin = new URL(url).origin;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- session (identique à l'app : jeton + utilisateur en stockage sécurisé) ---
let session = null;
if (login) {
  const [username, password] = login;
  const res = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).catch((e) => {
    console.error(`✗ /api/auth/login injoignable sur ${origin} : ${e.message}`);
    console.error('  Démarrez le backend (cd backend && npm start) et le serveur web (npm run serve:web).');
    process.exit(1);
  });
  if (!res.ok) {
    console.error(`✗ Connexion refusée (${res.status}) par ${origin}/api/auth/login`);
    process.exit(1);
  }
  session = await res.json();
}

const errors = [];
const logs = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => errors.push(String(e.detail ?? e.message ?? e).split('\n').slice(0, 8).join('\n')));
for (const level of ['error', 'warn']) {
  virtualConsole.on(level, (...args) => {
    const line = args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(' ');
    logs.push(`[${level}] ${line}`);
    if (level === 'error') errors.push(line);
  });
}

const dom = await JSDOM.fromURL(url, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    // jsdom n'expose pas tout ce qu'un bundle « navigateur » attend ; les
    // navigateurs ciblés par l'app fournissent tous ces éléments.
    window.WebAssembly ??= globalThis.WebAssembly;
    window.matchMedia ??= (q) => ({
      matches: false, media: q, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    });
    window.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    window.URL.createObjectURL ??= () => 'blob:jsdom';
    window.alert = () => {};
    window.confirm = () => true;
    if (!window.fetch) {
      window.fetch = (input, init) =>
        globalThis.fetch(typeof input === 'string' && input.startsWith('/') ? origin + input : input, init);
    }
    if (session) {
      window.localStorage.setItem('sm_token', session.token);
      window.localStorage.setItem('sm_user', JSON.stringify(session.user));
    }
  },
});

const root = () => dom.window.document.getElementById('root');
const textOf = () => (root()?.textContent ?? '').replace(/\s+/g, ' ').trim();

const settled = (value) => {
  if (login && !expectFlag) {
    // Attend que l'accueil *et* les données synchronisées soient arrivés.
    const m = /(\d+)\s*Motos disponibles/.exec(value);
    return Boolean(m && Number(m[1]) > 0);
  }
  return value.includes(expect);
};

const deadline = Date.now() + waitMs;
let text = '';
do {
  await sleep(250);
  text = textOf();
} while (Date.now() < deadline && !settled(text));

console.log(`URL    : ${url}`);
console.log(`#root  : ${root() ? `${root().children.length} élément(s)` : 'absent'}`);
console.log(`texte  : ${JSON.stringify(text.slice(0, 220))}`);
if (logs.length) console.log(`logs   :\n${logs.slice(0, 20).join('\n')}`);

let failed = false;
if (errors.length) {
  console.log(`\n✗ ${errors.length} erreur(s) runtime :\n${errors.slice(0, 5).join('\n---\n')}`);
  failed = true;
}
if (!text.includes(expect)) {
  console.log(`\n✗ Le rendu ne contient pas « ${expect} » — page blanche probable.`);
  failed = true;
}
// Avec un `--expect` explicite (ex. URL de raccourci `/?onglet=catalogue`),
// l'écran attendu n'est pas l'accueil : on laisse la vérification générique ci-dessus.
if (login && !expectFlag) {
  // Après connexion : l'accueil doit afficher les statistiques et le moteur de
  // synchronisation doit avoir rempli la base locale (pull des données de démo).
  const synced = /(\d+)\s*Motos disponibles/.exec(text);
  if (!text.includes('Motos disponibles')) {
    console.log('\n✗ Écran d’accueil absent après connexion (sync/rendu en échec).');
    failed = true;
  } else if (!synced || Number(synced[1]) === 0) {
    console.log('\n✗ Base locale vide : la synchronisation (pull API) n’a pas rempli la base SQLite web.');
    failed = true;
  } else {
    console.log(`\n✓ Connexion + synchronisation OK : ${synced[1]} moto(s) disponible(s) lues depuis la base locale.`);
  }
}

// --- navigation : changement d'onglet (onglet « Catalogue ») ---
if (!failed && login) {
  const doc = dom.window.document;
  const leafNodes = [...doc.querySelectorAll('*')].filter((e) => !e.children.length && (e.textContent ?? '').trim() === 'Catalogue');
  const tab = leafNodes[0];
  if (!tab) {
    console.log('\n✗ Onglet « Catalogue » introuvable dans la barre d’onglets.');
    failed = true;
  } else {
    tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, view: dom.window }));
    const navDeadline = Date.now() + 5000;
    let catalogue = '';
    do {
      await sleep(150);
      catalogue = textOf();
    } while (Date.now() < navDeadline && !doc.querySelector('input[placeholder^="Marque"]'));
    if (!doc.querySelector('input[placeholder^="Marque"]')) {
      console.log('\n✗ Clic sur l’onglet « Catalogue » sans effet (navigation/écrans en échec).');
      failed = true;
    } else {
      catalogue = textOf();
      const bikes = /Honda|Yamaha|Suzuki|Derbi/.test(catalogue) ? 'motos affichées' : 'liste vide';
      console.log(`\n✓ Navigation OK — écran Catalogue rendu (${bikes}).`);
    }
  }
}

// --- écriture : ajout d'une moto depuis le formulaire du catalogue ---
if (!failed && write) {
  const doc = dom.window.document;
  const clickText = (label) => {
    const node = [...doc.querySelectorAll('*')]
      .find((e) => !e.children.length && (e.textContent ?? '').trim() === label);
    if (!node) return false;
    node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, view: dom.window }));
    return true;
  };
  const setInput = (placeholder, value) => {
    const input = doc.querySelector(`input[placeholder="${placeholder}"]`);
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    return true;
  };

  const brand = `Marque ${Date.now() % 100000}`;
  const model = 'Sprint test';
  if (!clickText('＋')) {
    console.log('\n✗ Bouton d’ajout (＋) du catalogue introuvable.');
    failed = true;
  } else {
    let formReady = false;
    const formDeadline = Date.now() + 6000;
    while (!formReady && Date.now() < formDeadline) {
      await sleep(150);
      formReady = Boolean(doc.querySelector('input[placeholder="ex. XT 125 Z"]'));
    }
    if (!formReady) {
      console.log('\n✗ Formulaire d’ajout de moto non ouvert après un clic sur ＋.');
      failed = true;
    } else {
      setInput('ex. Yamaha', brand);
      setInput('ex. XT 125 Z', model);
      setInput('2500000', '3200000');
      if (!clickText('Ajouter au catalogue')) {
        console.log('\n✗ Bouton « Ajouter au catalogue » introuvable.');
        failed = true;
      } else {
        let saved = false;
        const saveDeadline = Date.now() + 8000;
        while (!saved && Date.now() < saveDeadline) {
          await sleep(200);
          saved = textOf().includes(model);
        }
        if (!saved) {
          console.log('\n✗ Moto enregistrée via le formulaire introuvable dans le catalogue.');
          failed = true;
        } else {
          // Le cycle de synchronisation (report de 800 ms) doit reprendre la main
          // sans casser l'UI : soit la file est poussée, soit elle reste en attente.
          await sleep(3000);
          const after = textOf();
          const ok = /Données à jour|modification en attente|conflit/i.test(after);
          if (!ok) {
            console.log(`\n✗ État de synchronisation incohérent après écriture : ${JSON.stringify(after.slice(0, 120))}`);
            failed = true;
          } else {
            console.log('\n✓ Écriture via formulaire OK (base locale + file de synchronisation).');
          }

          // La synchronisation doit avoir POUSSÉ l'écriture jusqu'au serveur :
          // c'est la preuve du cycle complet UI → SQLite web → file → push API.
          const q = await fetch(`${origin}/api/bikes?q=${encodeURIComponent(brand)}`, {
            headers: { Authorization: `Bearer ${session.token}` },
          }).catch(() => null);
          const body = q && q.ok ? await q.json() : null;
          const found = (body?.items ?? []).find((b) => b.model === 'Sprint test');
          if (!found) {
            console.log('\n✗ Écriture locale absente du serveur : le push de synchronisation n\'a pas abouti.');
            failed = true;
          } else {
            console.log(`✓ Synchronisation OK — la moto « ${found.brand} ${found.model} » est bien sur le serveur (prix ${found.price} Ar).`);
          }
        }
      }
    }
  }
}

// --- raccourci d'installation (PWA / APK) ---
if (!failed) {
  const doc = dom.window.document;
  const screen = textOf();
  // La carte « Installer » vit sur les écrans d'entrée (connexion, accueil) ;
  // un deep-link (`/?onglet=…`) peut rendre un autre écran : on n'exige alors
  // que le manifeste, qui est ce qui rend l'app installable.
  const onEntryScreen = /Se connecter|Bonjour,/.test(screen);
  const hasCard = /Installer Scoot Master|Installer l'application|Télécharger l'APK|Guide d'installation|application de bureau/i.test(screen);
  const manifest = doc.querySelector('link[rel="manifest"]');

  if (!manifest) {
    console.log('\n✗ Manifeste web non déclaré (<link rel="manifest">) : l\'app ne serait pas installable.');
    failed = true;
  } else if (onEntryScreen && !hasCard) {
    console.log('\n✗ Raccourci « Installer l\'application » absent de l\'écran rendu.');
    failed = true;
  } else {
    const res = await fetch(new URL(manifest.getAttribute('href'), origin)).catch(() => null);
    const ctype = res?.headers.get('content-type') || '';
    const man = res && res.ok ? await res.json().catch(() => null) : null;
    if (!res || !res.ok || !ctype.includes('manifest+json') || !man?.name) {
      console.log(`\n✗ Manifeste injoignable ou invalide (status=${res?.status}, content-type=${ctype}).`);
      failed = true;
    } else {
      console.log(`\n✓ Raccourci d'installation OK — manifeste « ${man.name} » (${man.icons?.length} icônes, display=${man.display})${hasCard ? ', carte « Installer » affichée' : ''}.`);
    }
  }
}

if (!failed && !login) {
  console.log(`\n✓ Application web rendue (${text.length} caractères de texte, 0 erreur runtime).`);
}
await dom.window.close?.();
process.exit(failed ? 1 : 0);
