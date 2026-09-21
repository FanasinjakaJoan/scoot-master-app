# 📦 Installation — Scoot Master

Ce guide couvre l'installation du **backend** (API de synchronisation) et de
l'**application mobile** (React Native / Expo), en développement comme en production.

---

## 1. Prérequis

| Outil | Version | Usage |
|---|---|---|
| Node.js | ≥ 20 (recommandé 22) | Backend + bundler |
| npm | ≥ 10 | Dépendances |
| Expo Go (smartphone) ou Xcode/Android Studio | — | Exécution mobile |
| Un navigateur | — | Tester l'API |

> Le backend n'a **aucune dépendance native** : la base SQLite est le module
> intégré `node:sqlite` (Node ≥ 22) — aucune compilation, installation instantanée.

---

## 2. Backend (API de synchronisation)

### 2.1 Installation

```bash
git clone <repo> scoot-master-app
cd scoot-master-app/backend
npm install
```

### 2.2 Configuration (optionnelle)

Copier `.env.example` vers `.env` et ajuster :

```ini
PORT=4000                          # port HTTP
DB_PATH=./data/scoot.db            # fichier SQLite (créé automatiquement)
JWT_SECRET=changez-moi-en-production
CORS_ORIGIN=*                      # '*' en dev, ou https://votre-domaine
SEED_ON_START=true                 # données de démo (comptes, motos, ventes)
```

Variables non définies : valeurs par défaut raisonnables (démo) sont utilisées.

### 2.3 Démarrage

```bash
npm start          # production (node src/server.js)
npm run dev        # développement (auto-reload)
```

Vérification :

```bash
curl http://localhost:4000/api/health
# {"ok":true,"service":"scoot-master-api","time":"..."}

curl -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
```

Comptes créés par le seed :

| Identifiant | Mot de passe | Rôle |
|---|---|---|
| `admin` | `admin123` | Administrateur (suppressions, validation de conflits, exports serveur) |
| `vendeur` | `vendeur123` | Vendeur (catalogue, ventes, clients) |

### 2.4 Tests

```bash
npm test           # 26 tests (node:test) — auth, CRUD, ventes, exports, sauvegardes, sync
```

### 2.5 Docker (optionnel)

```bash
cd backend
docker build -t scoot-master-api .
docker run -p 4000:4000 -v scoot-data:/app/data scoot-master-api
```

### 2.6 Production

- `JWT_SECRET` : chaîne longue aléatoire (`openssl rand -hex 32`).
- `CORS_ORIGIN` : gardez `*`. L'API s'authentifie par en-tête `Authorization`
  (aucun cookie) : refléter l'origine n'ouvre pas de faille CSRF, alors qu'une
  liste blanche trop restrictive coupe la synchronisation (`CORS_STRICT=true`
  pour durcir, uniquement si la liste est vérifiée).
- Base PostgreSQL : utiliser le DDL `docs/sql/postgresql_schema.sql` et remplacer
  l'adaptateur `src/db/connection.js` (l'interface `prepare/get/all/run/exec/
  transaction/close` est volontairement fine et portable).
- Placer le serveur derrière un reverse proxy TLS (nginx/Caddy).
- Sauvegarder le fichier `data/scoot.db` (ou la base Postgres).

---

## 3. Application mobile

### 3.1 Installation

```bash
cd scoot-master-app/mobile
npm install
```

L'app est développée avec **Expo SDK 57** (React Native 0.86, TypeScript).

### 3.2 Pointer l'app vers le backend

Le backend par défaut est `http://10.0.2.2:4000` (alias de `localhost` **vu d'un
émulateur Android**).

- **Émulateur Android** : aucune action (l'IP par défaut convient).
- **Émulateur iOS** : modifier `API_BASE_URL` dans `src/lib/config.ts` vers
  `http://localhost:4000`.
- **Vrai appareil** : l'app et le backend doivent être sur le même réseau Wi-Fi ;
  mettre l'IP locale de la machine backend, ex. `http://192.168.1.20:4000`.
  Alternative sans modification de code : définir `EXPO_PUBLIC_API_URL` au bundling
  (Expo lit les variables `EXPO_PUBLIC_*` de l'environnement).

### 3.3 Lancer

```bash
npx expo start
```

- **Expo Go** (le plus simple) : scanner le QR code avec l'app Expo Go sur iOS/Android.
- Builds natifs : `npx expo run:android` / `npx expo run:ios` (avec les toolchains
  installées), ou `npx expo prebuild` puis ouvrir les projets générés.

### 3.4 Tests & vérification du bundle

```bash
npm test                              # tests unitaires (jest) : LWW, CSV, formats
npx tsc --noEmit                      # typage strict
npx expo export --platform android    # bundle complet (Hermes) — détecte les imports cassés
```

### 3.5 Permissions

L'ajout de photos utilise la galerie :

- **iOS** : `NSPhotoLibraryUsageDescription` (déjà dans `app.json`/plugin expo-image-picker).
- **Android** : `READ_MEDIA_IMAGES` (déjà déclaré dans `app.json`).

### 3.6 Données locales & réinitialisation

- Base locale : `scootmaster.db` (stockage interne de l'app, persistant).
- Token & profil : `expo-secure-store` (cléring natif).
- Réinitialiser l'app = réinstaller l'app (ou vider son stockage).
- Navigateur : base `scootmaster.db` en IndexedDB (clé `scootmaster.db` de la
  base `scoot-master`), repli `localStorage` ; session en `localStorage`.
  Vider le stockage du site (ou les DevTools → Application → IndexedDB) remet
  l'app web à zéro.

### 3.7 Application web (navigateur)

Même code source, compilé pour le navigateur (React Native Web) :

```bash
npm run web          # développement : http://localhost:8081 (Metro relaie /api → :4000)
npm run build:web    # export statique → mobile/dist
npm run serve:web    # http://localhost:8080 (statique + relais /api vers le backend)
```

- L'API est appelée sur la **même origine** (`/api/...`) : pas de CORS, ni en
  développement (proxy Metro, cible `EXPO_WEB_API_TARGET`) ni en production
  (`deploy/web-server.js`).
- La base SQLite locale du navigateur est fournie par `sql.js` (moteur WASM sur
  le thread principal) via `src/data/local/db.web.ts` : pas de Web Worker, pas
  de `SharedArrayBuffer`, pas d'en-têtes COOP/COEP — l'app tourne aussi bien
  dans un onglet, une iframe qu'en export statique.
- Contrôles rapides :

```bash
npm run smoke:web                                    # écran de connexion, 0 erreur runtime
npm run smoke:web -- --login admin admin123 --write  # session, sync, navigation, formulaire
```

---

## 4. Premier scénario de validation (5 minutes)

1. `cd backend && npm start`
2. `cd mobile && npx expo start` → Expo Go
3. Connexion : `admin / admin123`
4. Onglet **Catalogue** : vérifier les 10 motos de démo, filtrer, trier.
5. Mode avion → créer une moto + un client + un bon de commande → l'indicateur
   passe à « X modifications en attente ».
6. Reconnecter → l'indicateur repasse « Données à jour » ; vérifier les mêmes
   enregistrements dans le backend (`curl /api/bikes`, `/api/sales`).
7. Onglet **Sync** : exporter le catalogue en CSV, faire une sauvegarde complète.
