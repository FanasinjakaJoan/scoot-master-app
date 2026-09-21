# 🏍️ Scoot Master — Application Mobile Offline-First

Application mobile de gestion pour **Scoot Master**, entreprise de vente de **motos 4T d'occasion** :
catalogue & stock, ventes / bons de commande, clients, et **synchronisation complète hors ligne**
avec résolution de conflits et exports JSON/CSV.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        APPLICATION MOBILE (React Native + Expo)             │
│                                                                             │
│  Écrans : Accueil · Catalogue · Ventes · Clients · Synchronisation          │
│                                                                             │
│  ┌───────────────┐  écriture   ┌─────────────────────────────────────────┐  │
│  │  Interfaces   │────────────▶│  BASE LOCALE SQLite (expo-sqlite)       │  │
│  │  (UI/UX)      │◀────────────│  bikes · customers · sales · items      │  │
│  └───────────────┘   lecture   │  + sync_queue · sync_conflicts · meta   │  │
│        ▲                       └──────────────┬──────────────────────────┘  │
│        │                                      │                             │
│        └──────────────┐   ┌───────────────────▼─────────────────┐           │
│                       │   │  MOTEUR DE SYNCHRONISATION          │           │
│                       │   │  (file d'actions, LWW, conflits)    │           │
│                       │   └───────────┬───────────────┬─────────┘           │
└───────────────────────┼───────────────┼───────────────┼─────────────────────┘
                        │               │ PUSH          │ PULL (curseur)
                        │               ▼               ▼
┌───────────────────────┴─────────────────────────────────────────────────────┐
│                     API NODE.JS (Express) + SQLite serveur                  │
│  /api/auth · /api/bikes · /api/customers · /api/sales                       │
│  /api/sync/push · /api/sync/pull  →  arbitrage Last-Write-Wins +            │
│                                      validation administrative (force)       │
│  /api/exports (JSON, CSV, sauvegardes)                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

## ✨ Fonctionnalités

**Catalogue & stock**
- Fiches motos 4T complètes : marque, modèle, année, kilométrage, cylindrée, couleur,
  n° de série, prix (Ariary), état mécanique & esthétique (1-5), photos, description,
  statut (disponible / réservée / maintenance / vendue).
- Recherche plein-texte, filtres (statut, marque, prix min/max), tri (récent, prix, km, marque).
- Statistiques : valeur du stock, motos disponibles, chiffre d'affaires du mois.

**Ventes & clients**
- Bons de commande **créables 100 % hors ligne** (numérotation locale `BC-AAAA-NNNN`,
  ré-affectée par le serveur en cas de collision).
- Lignes de vente (motos, quantité, prix unitaire), remise, mode de paiement,
  montant payé, statuts : brouillon → confirmée → livrée / annulée.
- Effet de domaine automatique : vente confirmée ⇒ motos « vendues » ;
  annulation ⇒ motos remises en stock (si libres) — appliqué **à la fois localement
  et côté serveur**.
- Clients : fiches complètes, statistiques d'achat, historique des achats.

**Offline-first & synchronisation**
- Base locale SQLite persistante : toutes les actions fonctionnent sans réseau.
- **File d'actions locales** (`sync_queue`) : chaque mutation est enregistrée + enfilée
  dans la même transaction — rien n'est perdu.
- **Synchronisation** automatique (reconnexion, retour d'arrière-plan, après chaque
  écriture) ou manuelle (bouton « Synchroniser »).
- Protocole **push** (opérations locales → serveur) / **pull** (changements serveur →
  local, avec curseur paginé) et arbitrage **Last-Write-Wins** sur horodatages ISO.
- **Gestion des conflits** : écran dédié, choix « conserver la version serveur » ou
  « forcer ma version » (réservé au rôle **admin** = validation administrative),
  relance des opérations échouées.
- **Exports & sauvegarde** : JSON ou CSV par entité depuis la base locale (fonctionne
  hors ligne), partage via la fiche de partage du téléphone, sauvegarde complète JSON
  et téléversement de la sauvegarde sur le serveur.
- Indicateur de statut permanent : *En ligne / Hors ligne* + *Données à jour /
  X modifications en attente / Y conflits à résoudre*.

## 📁 Structure du dépôt

```
scoot-master-app/
├── README.md                  ← ce fichier
├── render.yaml                ← Blueprint Render : 2 Web Services + disque (1 commande cloud)
├── docker-compose.yml         ← pile complète locale : API + app web (1 commande)
├── .github/workflows/         ← CI + CD GHCR + Build APK Android (Gradle)
├── deploy/web-server.js       ← serveur web statique + proxy /api + page /install + APK (zéro dépendance)
├── docs/
│   ├── RENDER.md              ← déploiement & hébergement Render (Web Service, guide complet)
│   ├── APK.md                 ← build APK Android (GitHub Actions, local Gradle, EAS)
│   ├── DEPLOYMENT.md          ← conteneurisation, CI/CD, Render, tester PC/mobile
│   ├── INSTALLATION.md        ← installation pas à pas (backend + mobile)
│   ├── DATABASE_SCHEMA.md     ← schéma local & cloud, dictionnaire de données
│   ├── SYNC.md                ← logique de synchronisation offline-first
│   ├── API.md                 ← référence complète de l'API REST
│   └── sql/postgresql_schema.sql  ← DDL PostgreSQL (déploiement cloud)
├── backend/                   ← API Node.js (Express + SQLite, zéro dépendance native)
│   ├── src/
│   │   ├── server.js / app.js
│   │   ├── config.js
│   │   ├── db/                ← schéma, init, seed, adaptateur node:sqlite
│   │   ├── middleware/        ← auth JWT, rôles, erreurs
│   │   ├── services/sync.js   ← moteur push/pull, LWW, force, renumérotation
│   │   └── routes/            ← auth, bikes, customers, sales, sync, exports
│   ├── tests/                 ← 26 tests (node:test) : API, auth, sync, sauvegardes
│   └── Dockerfile             ← image de production de l'API
└── mobile/                    ← App React Native (Expo SDK 57, TypeScript)
    ├── App.tsx                ← garde d'initialisation (base locale) + ErrorBoundary
    ├── Dockerfile             ← image web (expo export --platform web + proxy /api)
    ├── metro.config.js        ← asset WASM (sql.js web), repli modules node, proxy /api du dev server
    ├── scripts/web-smoke.mjs  ← smoke test « navigateur » (jsdom) du build web
    ├── src/
    │   ├── store/AppStore.tsx ← session, réseau, orchestration sync, hooks
    │   ├── navigation/        ← onglets + pile (React Navigation v7)
    │   ├── screens/           ← 12 écrans (login, accueil, catalogue, …)
    │   ├── components/        ← cartes, badges, formulaire, indicateur de statut
    │   ├── data/
    │   │   ├── local/         ← base SQLite (expo-sqlite natif / sql.js web) + repositories
    │   │   ├── api/           ← client HTTP (JWT)
    │   │   └── sync/          ← moteur de sync (push/pull), LWW, conflits
    │   ├── lib/               ← uuid, formatage, CSV, configuration, alert
    │   └── theme.ts
    └── __tests__/             ← tests unitaires (jest) : LWW, CSV, formats, base web
```

## 🚀 Démarrage rapide

### 1. Backend (API de synchronisation)

```bash
cd backend
npm install
npm start            # http://localhost:4000  (données de démo automatiquement)
```

- Page d'accueil HTML avec la liste des endpoints : <http://localhost:4000/>
- Comptes de démo : **admin / admin123** (administrateur) et **vendeur / vendeur123**.

```bash
npm test             # 26 tests : auth, rôles, CRUD, ventes, exports, sauvegardes, sync LWW/conflicts
```

### 2. Application mobile

```bash
cd mobile
npm install
npx expo start       # scanner avec l'app Expo Go (ou npm run android / ios)
```

- Pointez l'app vers le backend : par défaut `http://10.0.2.2:4000` (émulateur Android).
  Sur un vrai appareil, mettez l'IP de la machine qui héberge le backend dans
  `mobile/src/lib/config.ts` (`API_BASE_URL`) ou via la variable d'environnement
  `EXPO_PUBLIC_API_URL`.
- Détail complet : [docs/INSTALLATION.md](docs/INSTALLATION.md)

### 3. Application web (navigateur)

L'app Expo se compile aussi pour le navigateur (React Native Web) ; c'est la
version servie par `docker compose` et par Render.

```bash
cd mobile
npm run build:web    # expo export --platform web → mobile/dist
npm run serve:web    # http://localhost:8080  (statique + relais /api → backend)
```

- En développement, `npm run web` suffit : le serveur Metro relaie déjà `/api`
  vers `http://127.0.0.1:4000` (cible modifiable via `EXPO_WEB_API_TARGET`).
- La base locale SQLite tourne dans le navigateur grâce à `sql.js` (mêmes
  capacités SQL qu'en natif, instantanés persistés en IndexedDB) : voir
  `mobile/src/data/local/db.web.ts`. Aucune isolation cross-origin (COOP/COEP),
  aucun Web Worker et aucun `SharedArrayBuffer` ne sont requis — l'app fonctionne
  donc aussi bien en onglet, en iframe d'aperçu qu'en export statique.
- Vérification rapide du build (DOM simulé, sans navigateur) :

```bash
npm run smoke:web                     # écran de connexion rendu, 0 erreur runtime
npm run smoke:web -- --login admin admin123   # + session, sync pull, accueil, onglets
```

### 4. Scénario de démonstration (offline → conflit → résolution)

1. Mettez l'app en **mode avion** → créez une moto et un bon de commande (tout est
   enregistré localement, l'indicateur affiche « X modifications en attente »).
2. En parallèle, modifiez le prix de cette moto dans un autre appareil ou via l'API.
3. Rétablissez le réseau → l'app synchronise : le conflit apparaît dans
   l'onglet **Sync** → choisissez « Conserver le serveur » ou, en admin,
   « Forcer ma version ».

## 🧪 Tests

| Couche | Commande | Contenu |
|---|---|---|
| Backend | `cd backend && npm test` | 47 tests : auth JWT, rôles, CRUD, ventes (total, effets de domaine), exports JSON/CSV, sauvegarde (téléversement + liste admin), sync push/pull, LWW, conflits, `force` admin, renumérotation **et stabilité** du numéro de bon, pagination par curseur, **session longue + renouvellement + continuité pendant la synchro**, **révocation effective sur toutes les routes protégées** (compte supprimé/désactivé → 401, rôle lu en base) |
| API réelle | `cd backend && npm run check:api` | 48 contrôles de bout en bout contre le serveur **démarré** (vrai SQLite + stockage) : auth/rôles, push/pull + curseur, LWW, `force`, idempotence, ventes, tombstones, exports, sauvegarde (téléchargement / téléversement / liste admin). `BASE=https://… npm run check:api` pour viser un déploiement |
| Mobile | `cd mobile && npm test` | 74 tests : moteur LWW (arbitrage, tie-break, pull), génération CSV, formatage, identifiants hors ligne, adaptateur SQLite web (schéma, LIKE/agrégats, upsert, file de synchro, transactions et savepoints), **sauvegarde/exports locaux** (JSON complet, tombstones, CSV), **raccourci d'installation** (détection Android/iOS/bureau, plan affiché), **maintien de session pendant la synchro** (proactif/réactif, refus vs transitoire, force, sauvegarde) |
| Mobile (types) | `cd mobile && npx tsc --noEmit` | vérification TypeScript stricte |
| Web (rendu) | `cd mobile && npm run smoke:web` | le build exporté est servi puis exécuté dans un DOM simulé (jsdom) : écran rendu, **0 erreur runtime** — avec `-- --login admin admin123`, la session, le pull de synchronisation et la navigation sont validés ; avec `-- --stale-session`, une session dont le jeton est refusé par le serveur est validée via `POST /api/auth/check` (**toujours 200, ZÉRO 401**) puis retour à l'écran de connexion, aucun appel métier |
| Bundle | `cd mobile && npx expo export --platform web` | vérifie que l'app complète se bundle (web, WASM de SQLite inclus) |

## 🐳 Docker & Hébergement

### Local (1 commande)

```bash
docker compose up -d --build
# → app web : http://localhost:8080   (PC et navigateur mobile)
# → API     : http://localhost:4000   (admin / admin123)
```

### Render (Blueprint, 3 clics) — Choix Web Service

```bash
# render.yaml déclare 2 Web Services (type: web) + disque persistant
# Choix : Web Service et pas Private Service pour que l'API soit publique
# (mobile natif Expo Go a besoin de https://scoot-master-api.onrender.com)
# Dashboard Render → New + → Blueprint → sélectionnez le dépôt → Apply
# → API : https://scoot-master-api.onrender.com (Web Service, disque 1GB)
# → Web : https://scoot-master-web.onrender.com (Web Service, proxy /api → API en privé)
```

- **CI** (`.github/workflows/ci.yml`) : tests backend, smoke test API,
  TypeScript + Jest mobile, build des images Docker — à chaque push / PR.
- **CD** (`.github/workflows/deploy.yml`) : publication automatique des
  images `scoot-master-api` et `scoot-master-web` sur GitHub Container
  Registry à chaque merge sur `main`.
- **Render** : Blueprint `render.yaml` avec **2 Web Services** (`type: web` — choix explicite), réseau privé `fromService: hostport` (`scoot-master-api:10000`), healthchecks, disque persistant, `JWT_SECRET` auto-généré
  - Pourquoi pas `pserv` (private) ? Un private n'a pas d'URL publique → l'app mobile native ne pourrait pas joindre l'API. Web Service = public + privé à la fois.

### 📱 APK Android

APK Release prêt à installer (package `mg.scootmaster.app`) :

```bash
# Méthode GitHub Actions (recommandée, sans SDK local)
# Workflow .github/workflows/apk.yml build l'APK sur ubuntu-latest (Java 17 + Android SDK)
# → https://github.com/FanasinjakaJoan/scoot-master-app/actions/workflows/apk.yml
# Dernière build réussie : https://github.com/FanasinjakaJoan/scoot-master-app/actions/runs/35311464935
# Artifact : scoot-master-apk (112 MB, 2 APKs) — téléchargeable dans l'UI web

# Méthode locale (nécessite Android Studio)
cd mobile
./build-apk.sh
# → mobile/scoot-master-latest.apk
adb install mobile/scoot-master-latest.apk

# Méthode EAS Cloud
cd mobile
eas build --platform android --profile preview
```

- Config : `mobile/eas.json` (preview/production/local, buildType apk, API URL Render)
- Script : `mobile/build-apk.sh` (npm ci + expo prebuild + gradlew assembleRelease)
- Guide complet : 📖 [`docs/APK.md`](docs/APK.md)

### 📲 Raccourci « Installer l'application »

Un raccourci d'installation est présent **dans l'app** (écran de connexion et accueil,
navigateur uniquement) et sur la page **`/install`** du serveur web :

| Appareil | Ce que fait le raccourci |
|---|---|
| **Android (navigateur)** | invite d'installation PWA → icône au lanceur ; sinon bouton **Télécharger l'APK** |
| **PC (Chrome / Edge)** | invite d'installation → **application de bureau** (fenêtre dédiée, icône au menu Démarrer) |
| **iPhone / iPad (Safari)** | procédure « Partager → Sur l'écran d'accueil » (aucune invite programmatique sur iOS) |

- **PWA** : `mobile/public/manifest.webmanifest` (nom, icônes 192/512 + maskable,
  `display: standalone`, raccourcis Catalogue / Ventes / Sync) et `mobile/public/sw.js`
  (shell hors ligne ; `/api/*` n'est **jamais** mis en cache). Les deux sont copiés
  tels quels dans `dist/` par `expo export`, puis déclarés au démarrage
  (`src/lib/installApp.ts` ← `App.tsx`).
- **APK** : URL stable et publique
  `https://github.com/FanasinjakaJoan/scoot-master-app/releases/latest/download/scoot-master-latest.apk`
  (Release glissante publiée par le workflow APK à chaque build sur `main`).
  Surcharge au build : `EXPO_PUBLIC_APK_URL`.
- **APK auto-hébergé** : déposez le fichier dans `deploy/apk/scoot-master-latest.apk`
  (dossier git-ignoré) → la page `/install` et `/apk/scoot-master-latest.apk` le servent
  avec le bon type MIME ; sinon redirection vers la Release GitHub.

Détails complets :
- 📖 Local & GHCR : [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
- 🚀 Render (Web Service, 11 sections) : [`docs/RENDER.md`](docs/RENDER.md)
- 📱 APK (4 méthodes) : [`docs/APK.md`](docs/APK.md)

## ️ Base de données

- **Locale** (téléphone) et **serveur** partagent le même modèle métier :
  `bikes`, `customers`, `sales`, `sale_items` + colonnes de synchronisation
  (`created_at`, `updated_at`, `version`, `deleted_at`, `device_id`).
- Le téléphone ajoute `sync_queue`, `sync_conflicts`, `sync_meta`.
- Le serveur (démo) utilise SQLite (`node:sqlite`, sans dépendance native) ;
  le **DDL PostgreSQL** fourni dans `docs/sql/postgresql_schema.sql` couvre le
  déploiement cloud de production.
- Détail complet : [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md)

## ☁️ Logique de synchronisation

Résumé (détail : [docs/SYNC.md](docs/SYNC.md)) :

1. **Écriture locale immédiate** : chaque mutation passe par les repositories qui
   écrivent la base locale **et** enfilent l'opération (`entity`, `op`, `payload`,
   `clientTs`) dans la même transaction.
2. **Push** : par lots de 200, le client envoie la file au serveur. Le serveur
   arbitre **Last-Write-Wins** : `clientTs > updated_at(serveur)` → appliqué ;
   sinon → **conflit** renvoyé avec la version serveur (aucune perte de données).
3. **Pull** : le client tire les changements serveur depuis son dernier horodatage
   (curseur paginé, sans doublons) et n'applique un changement que s'il est plus
   récent que sa copie locale.
4. **Conflits** : listés dans l'app ; « conserver le serveur » (tout le monde) ou
   « forcer ma version » (**admin uniquement** — validation administrative).
   Les opérations échouées (réseau, serveur) sont relancées, puis marquées en
   échec après 5 tentatives avec relance manuelle possible.
5. **Suppressions** : logiques (tombstones `deleted_at`) pour se propager au pull.
6. **Effets de domaine** : le serveur rejoue les statuts des motos à chaque
   vente (confirmée ⇒ sold, annulée ⇒ disponible) ; une règle d'**idempotence**
   empêche les faux conflits quand les deux côtés ont déjà le même état.

## 🔐 Sécurité

- Authentification JWT (30 jours, renouvellement glissant via `POST /api/auth/refresh`,
  grâce de 60 jours pour les appareils restés hors ligne), mots de passe hachés (bcrypt).
  La session est **maintenue pendant la synchronisation** : renouvellement proactif entre
  deux lots/pages (via `POST /api/auth/refresh-safe`, toujours 200) et rejeu transparent
  de la requête en 401 — l'utilisateur n'est renvoyé vers la connexion que si le serveur
  refuse explicitement la session.
- Une session **restaurée au démarrage** (jeton conservé d'une exécution précédente) est
  validée par `POST /api/auth/check` (**toujours 200, jamais 401**) avant tout appel
  métier : un jeton devenu inutilisable produit **zéro 401 dans la console** puis
  l'écran de connexion — pas de requête de données envoyée pour rien, pas d'accueil
  affiché pour une session morte. C'est l'approche qui élimine le log
  « Failed to load resource: 401 » au chargement de l'app.
- **Révocation effective** : le compte est relu en base à chaque requête protégée. Un
  compte supprimé ou désactivé perd l'accès immédiatement (401 `revoked: true` sur les
  routes métier, ou `{ valid:false, revoked:true }` en 200 sur `/check`/`refresh-safe`),
  et le rôle autorisé est celui de la base — pas celui revendiqué dans le jeton.
- Rôles : `admin` (suppressions, validation de conflits, sauvegardes serveur) et
  `seller` (catalogue, ventes, clients).
- En production : changer `JWT_SECRET`, activer HTTPS. Laissez `CORS_ORIGIN=*` :
  l'API s'authentifie par en-tête (aucun cookie), et une liste blanche coupe la
  synchronisation dès que l'app web est servie sur une origine différente de l'API.

### Comprendre un `401` dans la console du navigateur

`Failed to load resource: the server responded with a status of 401` est le signal par
lequel le serveur indique « cette session n'est pas (ou plus) acceptée ». Depuis la
nouvelle approche, **aucun 401 n'est émis au chargement de l'app**, même pour une
session périmée :

| Origine | Ce que fait l'app (nouvelle approche) |
|---|---|
| `POST /api/auth/login` — identifiants erronés | Message « Identifiants incorrects. » ; les comptes de démo (`admin / admin123`, `vendeur / vendeur123`) sont rappelés sous le formulaire — 401 attendu, normal |
| Jeton expiré mais dans la grâce (60 j) | Renouvellement transparent via `POST /api/auth/refresh-safe` (**200**, pas 401) puis rejeu : **aucune déconnexion**, zéro 401 console |
| Jeton refusé (secret `JWT_SECRET` changé, base réinitialisée, compte supprimé/désactivé) | Validation via `POST /api/auth/check` → `{ valid:false }` en **200**, **zéro 401**, puis écran de connexion — **données locales et file de synchronisation conservées**, la transmission reprend à la reconnexion |
| Routes métier sans jeton (`/api/bikes`, `/api/sync/*`) | 401 normal si appel sans session — mais l'app ne les appelle plus avec un jeton invalide grâce à la validation préalable en 200 |

Un 401 **répété** en boucle n'est donc plus attendu au chargement : s'il apparaît, cela
signifie que le client appelle encore une route protégée avec un jeton invalide (ancienne
version du code) ou que le backend visé a changé de `JWT_SECRET`/base — se reconnecter
suffit, et la nouvelle validation en 200 évite le bruit console.

## 📄 Licence

MIT — voir [LICENSE](LICENSE).
