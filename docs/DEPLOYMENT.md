# 🚢 Déploiement & CI/CD — Scoot Master

Ce document décrit la conteneurisation, la pipeline CI/CD et les façons de
tester l'application (PC, navigateur mobile, smartphone natif).

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

- `ghcr.io/<org>/scoot-master-app/scoot-master-api:latest` (+ tag `sha-<commit>`)
- `ghcr.io/<org>/scoot-master-app/scoot-master-web:latest` (+ tag `sha-<commit>`)

### Déployer sur un serveur avec les images GHCR

```bash
docker login ghcr.io -u <utilisateur> -p <token-lecture-packages>
docker pull ghcr.io/<org>/scoot-master-app/scoot-master-api:latest
docker pull ghcr.io/<org>/scoot-master-app/scoot-master-web:latest
docker run -d --name api -p 4000:4000 -v scoot-data:/app/data \
  -e JWT_SECRET=<secret-fort> ghcr.io/<org>/scoot-master-app/scoot-master-api:latest
docker run -d --name web -p 8080:8080 -e API_TARGET=http://api:4000 \
  --link api ghcr.io/<org>/scoot-master-app/scoot-master-web:latest
```

(ou adaptez `docker-compose.yml` avec ces images au lieu des `build:`)

---

## 3. Tester l'application

### 3.1 Sur PC — navigateur

Ouvrir l'URL du service `web` (ex. `http://localhost:8080`). Se connecter
avec `admin / admin123`. Le catalogue, les ventes, les clients, les exports
(CSV/JSON téléchargés par le navigateur) et la synchronisation fonctionnent
comme sur mobile (stockage local SQLite via WASM).

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
