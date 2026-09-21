# 🚀 Déploiement & Hébergement sur Render — Scoot Master

Ce guide explique comment déployer **Scoot Master** (API + application web) sur [Render](https://render.com) en utilisant le **Blueprint** `render.yaml` fourni à la racine du dépôt.

---

## 1. Architecture sur Render

```
Internet (HTTPS)
    │
    ├─► scoot-master-web.onrender.com (service web Docker, plan starter)
    │     - Build : mobile/Dockerfile (multi-stage)
    │       Stage 1 : node:22-alpine → npm ci + expo export --platform web → /dist
    │       Stage 2 : node:22-alpine → sert /dist + proxy /api/*
    │     - Serveur : deploy/web-server.js (zéro dépendance, Node ≥20)
    │       * Fichiers statiques avec cache immutable pour _expo/static
    │       * Aucun en-tête d'isolation requis : la base SQLite web (sql.js)
    │         tourne sur le thread principal, pas dans un Worker + SharedArrayBuffer
    │       * Proxy HTTP minimal vers l'API via réseau privé
    │
    └─► scoot-master-api.onrender.com (service web Docker, plan starter)
          - Build : backend/Dockerfile (node:22-alpine, user non-root scoot)
          - API Express : src/server.js écoute sur $PORT (Render injecte 10000)
          - SQLite : /app/data/scoot.db sur disque persistant (1 GB)
          - Health : GET /api/health

Réseau privé Render (gratuit, interne) :
  scoot-master-web ──http://scoot-master-api:10000──► scoot-master-api
```

### Choix : Web Service (type: web) — pas Private Service

> **Décision d'architecture : on choisit 2 Web Services.**

| Critère | Web Service (`type: web`) ✅ choix retenu | Private Service (`type: pserv`) ❌ non retenu |
|---|---|---|
| **URL publique** | Oui, `https://*.onrender.com` + domaine custom + certificat auto | Non, uniquement réseau privé |
| **App mobile native (Expo Go)** | Fonctionne : appelle directement `https://scoot-master-api.onrender.com` | Ne fonctionne pas : API non joignable depuis l'extérieur |
| **App web navigateur** | Fonctionne : `https://scoot-master-web.onrender.com` | Fonctionne aussi, mais doit être web |
| **Réseau privé** | Oui, joignable aussi en privé via `scoot-master-api:10000` (hostport) | Oui, uniquement privé |
| **Tests curl/Postman** | Oui, public | Non, besoin d'un bastion |
| **Cas d'usage** | Prod complète (web + mobile natif) | Seulement si API 100% interne derrière le web |

**Pourquoi Web Service pour l'API ?**
- L'app mobile native ne passe PAS par le proxy web (`deploy/web-server.js`). Elle a besoin de l'URL publique de l'API (config `EXPO_PUBLIC_API_URL`).
- Les exports, sauvegardes, monitoring, et tests API doivent être accessibles sans passer par le web.
- On garde quand même le bénéfice du réseau privé : le web appelle l'API en `scoot-master-api:10000` (hostport) → latence <2ms, gratuit, pas de CORS.

**Pourquoi Web Service pour le Web ?**
- Doit être public pour les utilisateurs finaux (PC + mobile navigateur).
- Stateless, peut scaler horizontalement (`numInstances: 2`).

**Si on avait choisi Private Service pour l'API**, on aurait perdu l'app mobile native. Ce serait pertinent uniquement si on voulait que tout le trafic passe par le web (architecture proxy-only).

**Pourquoi 2 services et pas 1 ?**
- Séparation des responsabilités : l'API peut scaler indépendamment.
- Persistance : seul l'API a besoin d'un disque (SQLite). Le web est stateless.
- Sécurité : l'API reste accessible publiquement pour les apps mobiles natives (Expo Go), mais le web passe par le réseau privé pour éviter le CORS et la latence publique.

---

## 2. Prérequis

| Élément | Détail |
|---|---|
| Compte Render | https://dashboard.render.com (GitHub connecté) |
| Dépôt GitHub | Fork de `FanasinjakaJoan/scoot-master-app` (ou votre clone) |
| Plan Render | **Starter minimum** pour l'API (disque persistant non disponible en Free) |
| Node.js local | ≥20 pour tester avant déploiement (optionnel) |

**Coût estimé (2024-2026)** :
- `scoot-master-api` (Starter, 512 MB RAM, 0.5 CPU, 1 GB disk) : ~7 $/mois
- `scoot-master-web` (Starter ou Free) : 0-7 $/mois
- Trafic privé API ↔ Web : gratuit
- Total : ~7-14 $/mois. Voir https://render.com/pricing

---

## 3. Le fichier `render.yaml` (Blueprint as Code)

Le fichier à la racine déclare l'infrastructure :

```yaml
services:
  - type: web
    name: scoot-master-api
    runtime: docker
    dockerfilePath: ./backend/Dockerfile
    dockerContext: ./backend
    plan: starter
    healthCheckPath: /api/health
    envVars:
      - key: NODE_ENV
        value: production
      - key: JWT_SECRET
        generateValue: true
      - key: SEED_ON_START
        value: "true"
      - key: CORS_ORIGIN
        value: "*"
      - key: DB_PATH
        value: /app/data/scoot.db
    disk:
      name: scoot-master-data
      mountPath: /app/data
      sizeGB: 1

  - type: web
    name: scoot-master-web
    runtime: docker
    dockerfilePath: ./mobile/Dockerfile
    dockerContext: .
    healthCheckPath: /
    envVars:
      - key: API_TARGET
        fromService:
          type: web
          name: scoot-master-api
          property: hostport
```

### Points clés

| Champ | Explication |
|---|---|
| `runtime: docker` | Render build l'image via Docker, pas via buildCommand |
| `dockerContext` | Contexte de build. Pour le web, **racine** car `mobile/Dockerfile` copie `deploy/web-server.js` |
| `healthCheckPath` | Render ping ce chemin toutes les X secondes. Doit répondre 200. `/api/health` pour l'API, `/` pour le web |
| `plan: starter` | Obligatoire pour `disk`. Free ne supporte pas les disques persistants |
| `generateValue: true` | Render génère un secret aléatoire pour `JWT_SECRET` au premier déploiement |
| `fromService ... hostport` | Injection dynamique du host interne + port de l'API (ex: `scoot-master-api:10000`). Évite le hardcode. |
| `disk` | Volume persistant monté dans le conteneur. Sans disque, SQLite serait effacé à chaque redéploiement ! |

**Réseau privé :**
- Render injecte `PORT=10000` par défaut dans chaque web service.
- L'API écoute sur `process.env.PORT` (via `backend/src/config.js`).
- Le web lit `API_TARGET` (hostport) et le normalise en `http://host:port` dans `deploy/web-server.js`.
- Le proxy `deploy/web-server.js` relaie `/api/*` vers l'API avec `http.request`, en conservant méthode, headers et body.

**Build web (Expo) :**
- `mobile/Dockerfile` utilise `ARG EXPO_PUBLIC_API_URL=""` → build avec URL vide.
- L'app web appelle donc `/api/...` en **relatif** (même origine).
- Avantages : pas de CORS, fonctionne derrière n'importe quel domaine HTTPS, pas besoin de rebuild si l'URL API change (le proxy s'en charge).

---

## 4. Déploiement pas à pas (Blueprint)

### Méthode recommandée : Blueprint

1. **Poussez le code sur GitHub**
   ```bash
   git push origin main
   ```

2. **Render Dashboard**
   - Allez sur https://dashboard.render.com
   - `New +` → `Blueprint`
   - Connectez votre dépôt GitHub `votre-compte/scoot-master-app`
   - Render détecte `render.yaml`

3. **Configuration**
   - **Blueprint Name** : `scoot-master`
   - **Branch** : `main`
   - Vérifiez les 2 services listés : `scoot-master-api` et `scoot-master-web`
   - **Plan** : laissez `starter` (ou passez le web en `free` si vous voulez économiser)
   - Render vous demandera de confirmer la génération de `JWT_SECRET` (auto)

4. **Apply**
   - Cliquez `Apply`
   - Render lance 2 builds Docker en parallèle (2-4 minutes la première fois)
   - Suivez les logs : `Logs` → chaque service

5. **Premier démarrage**
   - L'API avec `SEED_ON_START=true` va :
     - Créer `/app/data/scoot.db` sur le disque
     - Appliquer le schéma (`backend/src/db/schema.js`)
     - Semer si vide : 2 comptes (`admin/admin123`, `vendeur/vendeur123`) + 10 motos + clients + ventes
   - Le web build Expo (`npx expo export`) prend ~60-90s, puis sert sur `$PORT`

6. **Vérification**
   ```bash
   curl https://scoot-master-api.onrender.com/api/health
   # {"ok":true,"service":"scoot-master-api","time":"..."}

   curl -X POST https://scoot-master-api.onrender.com/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"admin123"}'
   # {"token":"...","user":{...}}
   ```
   - Ouvrez `https://scoot-master-web.onrender.com` → login `admin / admin123`
   - Testez Catalogue, Ventes, Sync (devrait afficher "Données à jour")

### Méthode manuelle (sans Blueprint)

Si vous préférez créer les services à la main :

**API**
- `New +` → `Web Service` → connectez le dépôt
- **Runtime** : `Docker`
- **Dockerfile Path** : `./backend/Dockerfile`
- **Docker Context** : `./backend`
- **Plan** : `Starter`
- **Health Check Path** : `/api/health`
- **Env Vars** :
  - `NODE_ENV=production`
  - `JWT_SECRET` → `Generate` (bouton Render)
  - `SEED_ON_START=true`
  - `CORS_ORIGIN=*` (ou `https://votre-web.onrender.com`)
  - `DB_PATH=/app/data/scoot.db`
- **Disk** : Add Disk → Name `scoot-master-data`, Mount Path `/app/data`, Size `1 GB`
- Deploy

**Web**
- `New +` → `Web Service`
- **Runtime** : `Docker`
- **Dockerfile Path** : `./mobile/Dockerfile`
- **Docker Context** : `.` (racine, pas `./mobile` !)
- **Plan** : `Starter` ou `Free`
- **Health Check Path** : `/`
- **Env Vars** :
  - `API_TARGET=http://scoot-master-api:10000` (remplacez `scoot-master-api` par le nom réel de votre service API + port interne visible dans Dashboard → Connect → Internal)
  - Ou mieux : utilisez le nom interne exact affiché dans le dashboard API (ex: `scoot-master-api-xxxx:10000`)
- Deploy

---

## 5. Variables d'environnement

### API (`scoot-master-api`)

| Variable | Valeur Render | Description | Requis |
|---|---|---|---|
| `NODE_ENV` | `production` | Active optimisations Express | Oui |
| `PORT` | `10000` (injecté par Render) | Port d'écoute. `backend/src/config.js` lit `process.env.PORT` | Auto |
| `JWT_SECRET` | généré (`generateValue: true`) | Secret de signature JWT. **Ne pas partager**. Régénérer invalide tous les tokens | Oui |
| `JWT_TTL` | `30d` (défaut) | Durée de validité du token. L'app le renouvelle en arrière-plan : l'utilisateur reste connecté jusqu'à sa déconnexion | Non |
| `JWT_REFRESH_GRACE` | `60d` (défaut) | Délai pendant lequel un token expiré reste **renouvelable** (appareil resté hors ligne). Au-delà : reconnexion | Non |
| `SEED_ON_START` | `true` puis `false` | Sème la base si vide. Idempotent. Mettez `true` au premier déploiement, vous pouvez passer à `false` après pour éviter tout risque, mais `true` reste sûr | Recommandé `true` au début |
| `CORS_ORIGIN` | `*` (recommandé) | Origines autorisées. **Laissez `*`** : l'app web peut être redirigée par l'edge Render vers le domaine de l'API, ce qui rend l'appel cross-origin (voir « CORS et synchronisation » ci-dessous) | Recommandé `*` |
| `CORS_STRICT` | `false` | `true` refuse réellement les origines hors `CORS_ORIGIN` (le navigateur bloque alors la réponse). À n'activer que si `CORS_ORIGIN` est sûr et complet | Non |
| `DB_PATH` | `/app/data/scoot.db` | Chemin SQLite sur disque persistant | Oui |
| `SEED_ON_START` | `true` | Voir ci-dessus | |

### Web (`scoot-master-web`)

| Variable | Valeur | Description |
|---|---|---|
| `PORT` | `10000` (injecté) | Port d'écoute du serveur statique |
| `WEB_ROOT` | `/app/dist` (défaut Dockerfile) | Dossier du build Expo web |
| `API_TARGET` | `scoot-master-api:10000` via `fromService` | URL interne de l'API (hostport). `deploy/web-server.js` ajoute `http://` si manquant |
| `EXPO_PUBLIC_API_URL` | `""` (vide, via ARG dans Dockerfile) | Doit rester vide pour utiliser des chemins relatifs `/api` |

**Sécurité :**
- Laissez `CORS_ORIGIN=*` (défaut). L'API n'utilise **aucun cookie** : l'authentification passe uniquement par l'en-tête `Authorization: Bearer <JWT>`, qu'un site tiers ne peut ni lire ni rejouer. Refléter l'origine n'ouvre donc aucune faille CSRF, alors qu'une liste blanche incomplète coupe la synchronisation (voir « CORS et synchronisation »).
- `CORS_STRICT=true` durcit le comportement si vous voulez vraiment une liste blanche stricte. À réserver aux déploiements où `CORS_ORIGIN` est vérifié.
- `JWT_SECRET` doit être long et aléatoire (Render le génère). Ne le committez jamais.
- Pour forcer une rotation de secret : Dashboard → API service → Environment → `JWT_SECRET` → régénérer → redéployer (tous les utilisateurs seront déconnectés).

### CORS et synchronisation

L'app web appelle l'API en chemins relatifs (`/api/...`) et `deploy/web-server.js`
est censé les relayer en réseau privé (même origine ⇒ pas de CORS).

En pratique, l'edge de l'hébergeur intercepte ces chemins et répond par une
**redirection** `301`/`307` vers le domaine public de l'API
(`https://scoot-master-api.onrender.com/api/...`). L'appel devient donc
**cross-origin** dans le navigateur :

```bash
# constaté en production
curl -s -o /dev/null -D - https://scoot-master-web.onrender.com/api/health
# HTTP/2 301 → location: https://scoot-master-api.onrender.com/api/health

# et un pré-vol ne doit PAS suivre une redirection :
curl -s -o /dev/null -D - -X OPTIONS https://scoot-master-web.onrender.com/api/sync/push \
  -H 'Origin: https://scoot-master-web.onrender.com' \
  -H 'Access-Control-Request-Method: POST'
# HTTP/2 307 → location: https://scoot-master-api.onrender.com/api/sync/push  (au lieu de 204)
```

Sans `Access-Control-Allow-Origin` sur la réponse finale, le navigateur **bloque**
la réponse : la connexion, le push/pull de synchronisation et le téléversement de
sauvegarde échouent avec un message vu comme un **403**.

L'API renvoie donc désormais `Access-Control-Allow-Origin` de façon fiable
(`backend/src/middleware/cors.js`), pour toute origine, et répond elle-même au
pré-vol avec `204`. Diagnostic rapide :

```bash
curl -s -o /dev/null -D - https://scoot-master-api.onrender.com/api/health \
  -H 'Origin: https://scoot-master-web.onrender.com' | grep -i access-control
# doit contenir : access-control-allow-origin: https://scoot-master-web.onrender.com
```

---

## 6. Persistance des données (SQLite + Disk)

- **Sans disque**, le conteneur est éphémère : chaque redéploiement efface `/app/data`.
- **Avec disque** (`mountPath: /app/data`), Render attache un volume persistant (ext4) qui survit aux redéploiements, restarts, et même aux changements de plan.
- Taille : 1 GB minimum facturable. Pour Scoot Master, 1 GB = ~500k motos ou ~1M ventes (SQLite très compact). Suffisant pour une PME.
- **Backup** :
  - Via API : `GET /api/exports/backup` (admin) → télécharge un JSON complet
  - Via disque : Dashboard → API service → Shell → `ls -lh /app/data/` → `sqlite3 /app/data/scoot.db .dump > /tmp/dump.sql`
  - Automatisez avec un cron externe qui appelle l'endpoint backup quotidiennement

**Migration vers PostgreSQL (prod à grande échelle) :**
- Le DDL Postgres est fourni : `docs/sql/postgresql_schema.sql`
- Remplacez `backend/src/db/connection.js` par un adaptateur `pg`
- Sur Render, créez un `Postgres` database et injectez `DATABASE_URL` via `fromDatabase`
- Voir `docs/DATABASE_SCHEMA.md` pour les différences SQLite vs Postgres

---

## 7. Réseau privé & Proxy

### Flux d'une requête web

1. Navigateur → `https://scoot-master-web.onrender.com/api/bikes`
2. `deploy/web-server.js` (écoute sur `$PORT`) :
   - Si URL commence par `/api/` → `proxyApi()`
   - `http.request({hostname: API_URL.hostname, port: API_URL.port, path: req.url, method, headers})` vers `scoot-master-api:10000`
   - Pipe la réponse serveur → client
3. API répond → Web relaie → Navigateur

Avantages :
- Pas de CORS (même origine)
- HTTPS transparent (Render termine SSL au load balancer, puis HTTP interne)
- Pas besoin de configurer `EXPO_PUBLIC_API_URL` avec l'URL publique de l'API
- Latence privée < 2ms (vs 20-50ms via public)

### Pour l'app mobile native (Expo Go)

L'app native **ne passe pas** par le web. Elle appelle l'API directement :

```bash
# Dans mobile/src/lib/config.ts ou via env
EXPO_PUBLIC_API_URL=https://scoot-master-api.onrender.com
npx expo start
```

- En prod, vous pouvez publier l'URL publique de l'API dans la config de l'app.
- Sécurisez avec HTTPS (Render fournit HTTPS auto) + JWT.

---

## 8. Logs, Monitoring, Domaines, CI/CD

### Logs
- Dashboard → Service → `Logs` (temps réel, 7 jours de rétention sur plan Starter)
- Filtrez par niveau : l'API log `🏍️ Scoot Master API — http://0.0.0.0:10000`
- Pour persister les logs : intégrez un service externe (Logtail, Better Stack) via `console.log` → drain HTTP

### Health Checks
- **API** : `GET /api/health` → `{ok:true, service, time}`. Render redémarre le service si 3 échecs consécutifs.
- **Web** : `GET /` → `200` avec `index.html`. Si le build Expo échoue, le healthcheck échoue.
- Les Dockerfiles ont aussi un `HEALTHCHECK` interne (`wget`) compatible avec `$PORT` (fallback 4000/8080).

### Domaines personnalisés
- Dashboard → Service → `Settings` → `Custom Domains` → Ajoutez `app.votredomaine.com`
- Render fournit un certificat Let's Encrypt auto-renouvelé
- Mettez à jour `CORS_ORIGIN` pour inclure votre domaine custom

### Auto-deploy & CI/CD
- **Auto-deploy activé par défaut** : chaque push sur la branche liée (main) déclenche un build.
- **CI existante** (`.github/workflows/ci.yml`) : tests backend + mobile + build Docker → s'exécute avant le déploiement Render (si vous mettez une protection de branche).
- **CD GHCR** (`.github/workflows/deploy.yml`) : publie aussi sur GitHub Container Registry, utile si vous voulez déployer ailleurs en plus de Render.
- Pour désactiver l'auto-deploy : Dashboard → Service → Settings → `Auto-Deploy` → `No`, puis déployez manuellement via `Manual Deploy` → `Deploy latest commit`.

### Scaling
- **Vertical** : Dashboard → Scale → changez le plan (Starter → Standard → Pro)
- **Horizontal** : Render ne supporte pas plusieurs instances avec disque (SQLite = single-writer). Pour scaler horizontalement, migrez vers Postgres.
- **Web** : stateless, peut scaler horizontalement sans souci (ajoutez `numInstances: 2` dans `render.yaml` si besoin)

---

## 9. Dépannage (Troubleshooting)

| Symptôme | Cause probable | Solution |
|---|---|---|
| `Backend indisponible` (502 du web) | `API_TARGET` incorrect ou API crash | Vérifiez logs API, vérifiez que `API_TARGET` = `hostport` de l'API (Dashboard API → Connect → Internal). Redéployez le web après l'API |
| `no such table: users` | Disque non monté ou `DB_PATH` hors disque | Vérifiez `DB_PATH=/app/data/scoot.db` et que le disque est monté sur `/app/data`. Shell API : `ls /app/data/` |
| Healthcheck échoue | Port incorrect | L'API doit écouter sur `$PORT`. Vérifiez logs : `Scoot Master API — http://0.0.0.0:10000`. Si elle écoute sur 4000 alors que Render attend 10000, le healthcheck échoue. Ne forcez pas `PORT` manuellement, laissez Render l'injecter |
| `JWT malformed` après redéploiement | `JWT_SECRET` a changé | Tous les tokens signés avec l'ancien secret sont invalides. Les utilisateurs doivent se reconnecter. Évitez de régénérer `JWT_SECRET` en prod |
| **Déconnexion automatique peu après la connexion** | 1) `JWT_SECRET` non fixé : chaque redémarrage du service (ou chaque instance) génère un secret différent, invalidant les jetons en cours ; 2) `JWT_TTL` trop court ; 3) horloge de l'appareil décalée | 1) Fixez un `JWT_SECRET` **stable** dans l'environnement du service (ne le régénérez pas à chaque déploiement) et vérifiez qu'il est identique sur toutes les instances ; 2) laissez `JWT_TTL=30d` (défaut) ; 3) rien à faire côté client : l'app ne se fie plus à l'horloge locale et renouvelle la session auprès du serveur |
| Déconnexion après une nuit hors ligne | Jeton expiré au-delà de `JWT_REFRESH_GRACE` | Augmentez `JWT_REFRESH_GRACE` (défaut `60d`). En deçà, l'app renouvelle seule la session au retour du réseau |
| Build web échoue `expo export` | Mémoire insuffisante (Free plan) | Passez le web en Starter (512 MB → 1 GB RAM). Ou augmentez `NODE_OPTIONS=--max-old-space-size=2048` en env var |
| Base vide, pas de comptes | `SEED_ON_START=false` au premier démarrage | Mettez `SEED_ON_START=true`, redéployez. Vérifiez logs : seed ne s'exécute que si `users` vide |
| CORS error / « 403 » depuis le web | `CORS_ORIGIN` trop restrictif, ou l'edge redirige `/api/*` vers l'API (appel cross-origin) | L'API renvoie désormais toujours `Access-Control-Allow-Origin` (auth par en-tête, sans cookie). Vérifiez avec `curl … -H 'Origin: https://scoot-master-web.onrender.com'` (voir « CORS et synchronisation »). Si le pré-vol `OPTIONS /api/sync/push` renvoie `307` au lieu de `204`, l'appel ne peut pas aboutir : gardez `CORS_ORIGIN=*` et n'activez pas `CORS_STRICT` |
| Disque plein | Trop de données / photos base64 | SQLite stocke les photos en JSON `[]` (chemins). Si vous stockez des base64, le disque grossit vite. Passez à un stockage S3/R2 pour les photos. Augmentez `sizeGB` dans `render.yaml` |

**Commandes utiles (Shell Render) :**
```bash
# Ouvrir un shell sur l'API : Dashboard → API → Shell
ls -lh /app/data/
sqlite3 /app/data/scoot.db "SELECT COUNT(*) FROM bikes; SELECT COUNT(*) FROM users;"
cat /app/data/scoot.db | wc -c
env | grep -E "PORT|API_TARGET|DB_PATH"
wget -qO- http://127.0.0.1:10000/api/health
```

---

## 10. Checklist de mise en production

- [ ] `render.yaml` présent à la racine, avec `fromService: hostport` pour `API_TARGET`
- [ ] `backend/Dockerfile` et `mobile/Dockerfile` healthcheck utilisent `${PORT:-...}`
- [ ] `deploy/web-server.js` normalise `API_TARGET` sans schéma
- [ ] `SEED_ON_START=true` pour le premier déploiement (puis optionnellement `false`)
- [ ] `JWT_SECRET` généré par Render (`generateValue: true`), pas hardcodé
- [ ] `CORS_ORIGIN` restreint à votre domaine web en prod
- [ ] Disque `scoot-master-data` monté sur `/app/data`, `DB_PATH=/app/data/scoot.db`
- [ ] Test `curl /api/health` et login `admin/admin123` après déploiement
- [ ] Test web `https://...onrender.com` → login → catalogue → création moto → sync
- [ ] Sauvegarde : `GET /api/exports/backup` planifiée (cron externe)
- [ ] Domaine custom + certificat HTTPS (si besoin)
- [ ] Monitoring logs + alertes (Render → Notifications → Slack/Email)
- [ ] Documentation interne : URL prod, comptes, procédure de restore

---

## 11. Ressources

- **Blueprint spec** : https://render.com/docs/blueprint-spec
- **Private networking** : https://render.com/articles/how-render-handles-private-networking
- **Web services** : https://render.com/docs/web-services
- **Disks** : https://render.com/docs/disks
- **Docker on Render** : https://render.com/docs/docker
- **Dépôt Scoot Master** : `docs/DEPLOYMENT.md` (Docker Compose local), `docs/INSTALLATION.md`, `docs/API.md`
- **Support Render** : https://community.render.com

---

**Besoin d'aide ?**
Ouvrez une issue GitHub ou consultez les logs Render. Pour une prod à grande échelle (multi-utilisateurs, photos, >10 GB), envisagez la migration Postgres décrite dans `docs/DATABASE_SCHEMA.md` + stockage objet (S3/R2) pour les photos.
