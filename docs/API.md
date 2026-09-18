# 📡 Référence API — Scoot Master

Base URL : `http://localhost:4000` (démo). Authentification : en-tête
`Authorization: Bearer <JWT>` (obtenu via `POST /api/auth/login`).

Légende : 🔓 public · 🔑 connecté · 👑 admin.

## Statut

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/` | 🔓 | Page HTML de découverte (liste des endpoints) |
| GET | `/api/health` | 🔓 | `{"ok":true,"service":"scoot-master-api","time":…}` |

## Authentification

| Méthode | Route | Accès | Body / Renvoie |
|---|---|---|---|
| POST | `/api/auth/login` | 🔓 | `{username, password}` → `{token, expiresAt, expiresIn, user{id, username, fullName, role}}` — 401 si identifiants erronés. `expiresAt` (epoch ms, calculé par le serveur) permet au client de renouveler sans dépendre de l'horloge de l'appareil |
| GET | `/api/auth/me` | 🔑 | → `{user}` (profil courant) |
| POST | `/api/auth/refresh` | 🔑 | Renouvelle le jeton (glissement de session) : re-vérifie en base que le compte existe et reste actif → `{token, expiresAt, expiresIn, user}`. Accepte aussi un jeton **récemment expiré** (fenêtre `JWT_REFRESH_GRACE`, 60 j par défaut) afin qu'un appareil resté hors ligne retrouve sa session. 401 JSON si jeton mal signé, expiré hors tolérance, ou compte supprimé/désactivé — le client déclenche alors la réauthentification **sans purger sa file locale** |

Toutes les réponses d'erreur sont JSON explicites : `{"error":"Authentification requise."}`,
`{"error":"Jeton invalide ou expiré."}`, `{"error":"Droits insuffisants (rôle requis : admin)."}`…

## Utilisateurs (gestion des comptes)

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/api/users` | 👑 | Liste complète `{users[{id, username, fullName, role, active, createdAt, updatedAt}]}` |
| POST | `/api/users` | 👑 | `{username, password (8 car. min), fullName, role: admin\|seller}` → 201 `{user}` |
| PATCH | `/api/users/profile` | 🔑 | **Mon profil** (auto-service) : `{fullName?, password?}` → `{ok, user}`. Le rôle et le statut ne sont PAS modifiables par cette voie |
| PATCH | `/api/users/:id` | 🔑 soi · 👑 | Édition : `fullName?`, `password?` (soi ou admin) ; `role?`, `active?` (**admin uniquement**). Un admin ne peut ni changer son propre rôle ni se désactiver. `active` non fourni ⇒ statut inchangé (une édition ne réactive jamais un compte désactivé) |
| PUT | `/api/users/:id` | 🔑 soi · 👑 | Alias de `PATCH /api/users/:id` |

## Catalogue — motos

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/api/bikes` | 🔑 | Liste paginée. Filtres : `status`, `brand`, `q` (recherche), `minPrice`, `maxPrice`, `sort` (`updated_at`\|`price`\|`mileage_km`\|`brand`), `order` (`asc`\|`desc`), `page`, `limit`. → `{items, total, page, limit}` |
| GET | `/api/bikes/meta` | 🔑 | → `{brands[], statuses[]}` (valeurs pour les filtres) |
| GET | `/api/bikes/:id` | 🔑 | Fiche complète (404 si absente/supprimée) |
| POST | `/api/bikes` | 🔑 | Création : `brand*, model*, price, mileage_km, year, engine_cc, color, serial_number, mechanical_state, aesthetic_state, status, description, warehouse, photos[]`. → 201 `{bike}` |
| PUT | `/api/bikes/:id` | 🔑 | Mise à jour partielle (mêmes champs) |
| DELETE | `/api/bikes/:id` | 👑 | Suppression logique (tombstone) |

## Clients

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/api/customers` | 🔑 | Liste + `nb_sales` et `total_spent` par client. Filtre `q`, `page`, `limit` |
| GET | `/api/customers/:id` | 🔑 | Fiche client |
| GET | `/api/customers/:id/purchases` | 🔑 | Historique des achats : `{sales[]}` avec lignes + motos |
| POST | `/api/customers` | 🔑 | `first_name*, last_name*, phone*, email, address, notes` → 201 |
| PUT | `/api/customers/:id` | 🔑 | Mise à jour partielle |
| DELETE | `/api/customers/:id` | 👑 | Suppression logique |

## Ventes / bons de commande

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/api/sales` | 🔑 | Liste (client + lignes résolus). Filtres : `status`, `customerId`, `from`, `to` (AAAA-MM-JJ) |
| GET | `/api/sales/:id` | 🔑 | Bon complet : lignes + motos, client, total, paiement |
| POST | `/api/sales` | 🔑 | `customer_id*`, `items*[{bike_id, unit_price, quantity}]`, `discount`, `amount_paid`, `payment_method`, `status` (`brouillon` def.), `sale_date`, `notes` → 201. **Recalcule le total**, alloue le n° de bon, applique l'effet de domaine (motos → `sold` si confirmée) |
| PUT | `/api/sales/:id` | 🔑 | `status`, `amount_paid`, `payment_method`, `discount`, `notes`, `items[]` (remplacement) — recalcul + effets de domaine |
| DELETE | `/api/sales/:id` | 👑 | Suppression logique + remise en stock des motos libres |

## Synchronisation

| Méthode | Route | Accès | Description |
|---|---|---|---|
| POST | `/api/sync/push` | 🔑 | `{deviceId, operations[]}` (≤ 500). Chaque op : `{entity, op, id, payload, clientTs, force?}`. → `{serverTime, stats, results[]}`. Voir `docs/SYNC.md` §3 |
| GET | `/api/sync/pull` | 🔑 | `?since=ISO&cursor=&limit=` (limit ≤ 2000). → `{serverTime, changes[], nextCursor}`. Voir `docs/SYNC.md` §4 |
| GET | `/api/sync/status` | 🔑 | Compteurs globaux (diagnostic) |

## Exports & sauvegardes

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/api/exports/bikes?format=json\|csv` | 🔑 | Export catalogue (CSV BOM UTF-8 pour Excel) |
| GET | `/api/exports/customers?format=…` | 🔑 | Export clients |
| GET | `/api/exports/sales?format=…` | 🔑 | Export ventes |
| GET | `/api/exports/backup` | 🔑 | Sauvegarde complète JSON (tombstones inclus) |
| POST | `/api/exports/backup` | 🔑 | `{fileName, data}` — téléverse une sauvegarde locale (stockage serveur `storage/backups/`) |
| GET | `/api/exports/backups` | 👑 | Liste des sauvegardes téléversées |

## Codes d'erreur

| Code | Signification |
|---|---|
| 400 | Corps invalide / champ manquant / limite dépassée |
| 401 | Non authentifié (jeton absent/invalide/expiré) |
| 403 | Rôle insuffisant (ex. suppression par un `seller`, `force` non admin) |
| 404 | Entité introuvable (ou supprimée) |
| 500 | Erreur interne (journalisée côté serveur) |

## Format JSON des entités

Toutes les réponses utilisent les noms de colonnes du schéma
(`snake_case`, cf. `docs/DATABASE_SCHEMA.md`) :

```jsonc
// bike
{ "id": "…", "brand": "Yamaha", "model": "XT 125 Z", "year": 2021,
  "mileage_km": 18450, "engine_cc": 125, "color": "Noir", "serial_number": "…",
  "price": 2850000, "currency": "MGA", "mechanical_state": 4, "aesthetic_state": 4,
  "status": "available", "description": "…", "warehouse": "Magasin Antananarivo",
  "photos": ["…"], "created_at": "…", "updated_at": "…", "version": 3,
  "created_by": "…", "updated_by": "…", "device_id": "…", "deleted_at": null }

// sale (liste)
{ "id": "…", "sale_number": "BC-2026-0005", "customer": { "id", "first_name", "last_name", "phone" },
  "items": [ { "id", "bike_id", "unit_price", "quantity", "bike": { "id", "brand", "model" } } ],
  "total": 2800000, "discount": 50000, "amount_paid": 2800000,
  "payment_method": "cash", "payment_status": "paid", "status": "confirme",
  "sale_date": "2026-09-17", "notes": null, "created_at": "…", "updated_at": "…" }
```
