# 🚢 Déploiement & CI/CD — Scoot Master

Ce document décrit la conteneurisation, la pipeline CI/CD, l'hébergement sur **Render** et les façons de
tester l'application (PC, navigateur mobile, smartphone natif).

> **Hébergement Render ?** Guide complet dédié : [`docs/RENDER.md`](RENDER.md) — Blueprint `render.yaml`, réseau privé, disque persistant, variables, troubleshooting, checklist prod.

---

## 1. Architecture conteneurisée

| Service | Image | Rôle | Port |
|---|---|---|---|
| `api` | `scoot-master-api` | API Express + SQLite (`backend/Dockerfile`) | 4000 |
| `web` | `scoot-master-web` | Build web de l'app Expo + proxy `/api` (`mobile/Dockerfile`, serveur `deploy/web-server.js`) | 8080 |

L'app web est compilée avec `EXPO_PUBLIC_API_URL=""` : elle appelle l'API en
**chemins relatifs** (`/api/...`), le service `web` relaie vers `api`. Aucun
CORS à configurer, fonctionne derrière n'importe quel HTTPS.

### Démarrage (une commande)

```bash
docker compose up -d --build
```

- Application web : <http://localhost:8080> (PC **et** navigateur mobile)
- API : <http://localhost:4000> (page d'accueil = catalogue des endpoints)
- Connexion démo : `admin / admin123` ou `vendeur / vendeur123`
- Base SQLite persistée dans le volume `api-data`

Variables d'environnement (optionnelles) : `JWT_SECRET`, `SEED_ON_START`.

```bash
docker compose down            # arrêter
docker compose down -v         # arrêter + réinitialiser la base
```

### Construire les images séparément

```bash
docker build -t scoot-master-api backend/
docker build -f mobile/Dockerfile -t scoot-master-web .   # contexte = racine du dépôt
```

---

## 2. CI/CD (GitHub Actions)

### `CI` — `.github/workflows/ci.yml` (à chaque push / PR)

1. **Tests backend** : suite `node --test` (auth, API, sync LWW/conflits).
2. **Smoke test backend** : démarrage réel du serveur, vérification de
   `/api/health`, login démo, appel authentifié du catalogue.
3. **Mobile** : vérification TypeScript (`tsc --noEmit`) + tests Jest
   (LWW, CSV, formatage).
4. **Build Docker** : compilation des deux images (API + web) via buildx
   avec cache GHA — valide que les images restent constructibles.

### `CD` — `.github/workflows/deploy.yml` (à chaque merge sur `main`)

Publie automatiquement sur **GitHub Container Registry** :

- `ghcr.io/fanasinjakajoan/scoot-master-app/scoot-master-api:latest` (+ tag `sha-<commit>`)
- `ghcr.io/fanasinjakajoan/scoot-master-app/scoot-master-web:latest` (+ tag `sha-<commit>`)

> Les noms d'images GHCR sont entièrement en minuscules (le nom du dépôt est
> converti automatiquement par le workflow).

### Déployer sur un serveur avec les images GHCR

```bash
docker login ghcr.io -u <utilisateur> -p <token-lecture-packages>
docker pull ghcr.io/fanasinjakajoan/scoot-master-app/scoot-master-api:latest
docker pull ghcr.io/fanasinjakajoan/scoot-master-app/scoot-master-web:latest
docker run -d --name api -p 4000:4000 -v scoot-data:/app/data \
  -e JWT_SECRET=<secret-fort> ghcr.io/fanasinjakajoan/scoot-master-app/scoot-master-api:latest
docker run -d --name web -p 8080:8080 -e API_TARGET=http://api:4000 \
  --link api ghcr.io/fanasinjakajoan/scoot-master-app/scoot-master-web:latest
```

(ou adaptez `docker-compose.yml` avec ces images au lieu des `build:`)

---

## 3. Tester l'application

### 3.1 Sur PC — navigateur

Ouvrir l'URL du service `web` (ex. `http://localhost:8080`). Se connecter
avec `admin / admin123`. Le catalogue, les ventes, les clients, les exports
(CSV/JSON téléchargés par le navigateur) et la synchronisation fonctionnent
comme sur mobile.

Sans Docker, depuis le dépôt :

```bash
cd backend && npm install && npm start &      # API : http://localhost:4000
cd ../mobile && npm install
npm run build:web                             # expo export --platform web → mobile/dist
npm run serve:web                             # http://localhost:8080 (statique + relais /api)
npm run smoke:web -- --login admin admin123   # contrôle automatique du rendu (DOM simulé)
```

Le stockage local du navigateur est une vraie base SQLite (`sql.js`, moteur
WASM exécuté sur le thread principal, fichier persisté en IndexedDB — voir
`mobile/src/data/local/db.web.ts`) : mêmes requêtes, mêmes transactions et mêmes
comportements offline-first que sur l'appareil natif. Aucun en-tête
COOP/COEP, aucun Web Worker et aucun `SharedArrayBuffer` ne sont nécessaires —
l'app se comporte donc à l'identique en onglet, en iframe ou en export statique.

### 3.2 Sur mobile — navigateur

Même URL dans le navigateur du téléphone (sur le même réseau :
`http://<ip-du-serveur>:8080`, ou URL publique si déployé en ligne).

### 3.3 Sur mobile — application native (Expo Go)

```bash
cd mobile
# URL de l'API accessible depuis le téléphone :
EXPO_PUBLIC_API_URL=http://<ip-du-serveur>:4000 npx expo start
```

Scanner le QR code avec **Expo Go** (Android / iOS). L'app native utilise le
Secure Store (Keychain/Keystore) et le stockage SQLite embarqué.

### 3.4 API seule (Postman / curl)

```bash
curl https://<hote>:4000/api/health
curl -X POST https://<hote>:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
```

La page d'accueil de l'API liste tous les endpoints avec leurs paramètres.

---

## 4. Tests & validation locale

```bash
# Backend — 24 tests (auth, CRUD, exports, sync push/pull, LWW, conflits)
cd backend && npm ci && npm test

# Mobile — vérification des types + 12 tests Jest (LWW, CSV, formatage)
cd mobile && npm ci && npx tsc --noEmit && npx jest
```

Ces commandes sont exactement celles exécutées par la CI.

---

## 5. Hébergement sur Render (Blueprint)

Render est la cible d'hébergement recommandée pour une démo publique ou une petite production (PME).

### 5.1 Architecture Render — Choix Web Service

**Choix : 2 Web Services (`type: web`), pas Private Service.**

- `scoot-master-api` : **Web Service** Docker + disque persistant 1 GB (`/app/data/scoot.db`), healthcheck `/api/health`
  - Doit être public pour l'app mobile native Expo Go (qui appelle l'API directement)
  - Joignable aussi en privé par le web via `fromService: hostport` → `scoot-master-api:10000`
- `scoot-master-web` : **Web Service** Docker (build Expo web statique) + proxy `/api` → API via réseau privé
  - Public pour navigateurs PC/mobile, stateless, scalable

> Pourquoi pas Private Service (`pserv`) ? Un `pserv` n'a pas d'URL publique : l'app mobile native ne pourrait plus joindre l'API. On le choisirait uniquement si on voulait que tout passe par le proxy web. Notre choix Web Service permet web + mobile natif + tests directs.

- Build web avec `EXPO_PUBLIC_API_URL=""` → chemins relatifs, pas de CORS
- Fichier d'infrastructure : `render.yaml` à la racine, avec `type: web` explicite + commentaires choix.

### 5.2 Déploiement en 3 clics

1. Fork le dépôt sur GitHub
2. Render Dashboard → `New +` → `Blueprint` → sélectionnez le dépôt (Render détecte `render.yaml`)
3. `Apply` → 2 services se buildent (2-4 min). `SEED_ON_START=true` crée `admin/admin123` au premier démarrage.

URLs :
- API : `https://scoot-master-api.onrender.com/api/health`
- Web : `https://scoot-master-web.onrender.com` (login démo)

### 5.3 Variables & réseau privé

- Render injecte `PORT=10000` automatiquement. L'API écoute dessus (`config.js` lit `process.env.PORT`).
- `API_TARGET` est injecté via `fromService: hostport` → `scoot-master-api:10000`, normalisé en `http://...` par `deploy/web-server.js`.
- `JWT_SECRET` généré auto (`generateValue: true`), `CORS_ORIGIN=*` en dev, restreignez en prod.
- Disque obligatoire en `starter` minimum (Free ne supporte pas les disks).

**Guide complet** : [`docs/RENDER.md`](RENDER.md) — 11 sections : architecture détaillée, coûts, logs, domaines custom, scaling, troubleshooting, checklist prod, migration Postgres.

### 5.4 Alternative manuelle

Sans Blueprint : créez 2 Web Services Docker manuellement (Dockerfile paths `./backend/Dockerfile` et `./mobile/Dockerfile`, contexte racine pour le web), ajoutez un disque sur l'API (`/app/data`), et liez `API_TARGET=http://scoot-master-api:10000` (nom interne visible dans Dashboard → Connect → Internal).
