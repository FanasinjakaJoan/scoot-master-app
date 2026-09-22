# 🗄️ Schéma de la base de données — Scoot Master

Deux bases partagent le **même modèle métier** (garanti par convention et par les
colonnes de synchronisation) :

- **Base locale** (téléphone, SQLite via `expo-sqlite`) — source de vérité hors ligne ;
  DDL : `mobile/src/data/local/db.ts`.
- **Base serveur** (SQLite en démo via `node:sqlite` ; PostgreSQL en production,
  DDL : `docs/sql/postgresql_schema.sql`) ; DDL démo : `backend/src/db/schema.js`.

## 1. Vue d'ensemble (ERD)

```
 users (serveur uniquement)
   │
   │ created_by / updated_by
   ▼
 bikes ◄────────────── sale_items ──────────────► sales ◄────── customers
   │                          │                    │              │
   │ status: available /      │ unit_price (prix   │ status:      │ historique
   │ reserved /               │ verrouillé à la    │ brouillon /  │ = sales WHERE
   │ maintenance / sold       │ vente)             │ confirme /   │ customer_id
   │                          │ quantity           │ livre /      │
   │ photos: JSON[]           │                    │ annule       │
   │                                                                  │
   └─ colonnes de synchronisation communes :                         │
      id (UUID client), created_at, updated_at, version,             │
      created_by, updated_by, owner_id, device_id,                   │
      deleted_at (tombstone)                                         │
```

`owner_id` porte la **propriété** de la ligne (isolation « Row-Level Security ») :
il vaut l'id de l'utilisateur qui a créé la ligne, est imposé par le serveur, et
sert de filtre à toutes les lectures/écritures pour les comptes non admin.

**Tables locales uniquement** (téléphone) : `sync_queue`, `sync_conflicts`, `sync_meta`.

## 2. `bikes` — motos du catalogue

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | TEXT (UUID) | PK | Généré par l'appareil client (créations hors ligne) |
| `brand` | TEXT | NOT NULL | Marque (Yamaha, Honda, …) |
| `model` | TEXT | NOT NULL | Modèle (XT 125 Z, …) |
| `year` | INTEGER | NULL | Année de fabrication |
| `mileage_km` | INTEGER | NOT NULL, ≥ 0 | Kilométrage |
| `engine_cc` | INTEGER | NULL | Cylindrée (50, 110, 125, …) |
| `color` | TEXT | NULL | Couleur |
| `serial_number` | TEXT | NULL | Numéro de série / châssis |
| `price` | INTEGER | NOT NULL, ≥ 0 | Prix en unités mineures de la devise (Ariary) |
| `currency` | TEXT | NOT NULL, def. `MGA` | Code devise |
| `mechanical_state` | INTEGER | 1..5 | État mécanique (1=Mauvais … 5=Excellent) |
| `aesthetic_state` | INTEGER | 1..5 | État esthétique |
| `status` | TEXT | `available`\|`reserved`\|`maintenance`\|`sold` | Statut stock |
| `description` | TEXT | NULL | Description libre |
| `warehouse` | TEXT | NULL | Magasin / lieu |
| `photos` | TEXT (JSON) | def. `[]` | Tableau d'URIs (fichiers locaux ou URLs) |
| `created_at` / `updated_at` | TEXT ISO-8601 UTC | NOT NULL | Clés LWW |
| `version` | INTEGER | def. 0 | Incrémenté à chaque changement |
| `created_by` / `updated_by` | TEXT | NULL | Utilisateur (id serveur) |
| `owner_id` | TEXT | NULL | Propriétaire (isolation RLS) — imposé par le serveur |
| `device_id` | TEXT | NULL | Appareil de la dernière modification (tie-break) |
| `deleted_at` | TEXT | NULL | **Tombstone** — suppression logique |

Index : `status`, `brand`, `updated_at` (pull), `deleted_at`, `owner_id`.

## 3. `customers` — clients

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | TEXT (UUID) | PK | Généré côté client |
| `first_name` / `last_name` | TEXT | NOT NULL | Prénom / Nom |
| `phone` | TEXT | NOT NULL | Téléphone (recherche principale) |
| `email` | TEXT | NULL | |
| `address` | TEXT | NULL | |
| `notes` | TEXT | NULL | Observations (préférences, remises…) |
| + colonnes de synchronisation communes | | | |

## 4. `sales` — ventes / bons de commande

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | TEXT (UUID) | PK | Généré côté client |
| `sale_number` | TEXT | UNIQUE | `BC-AAAA-NNNN` — proposé par le client, **garanti unique par le serveur** (ré-affectation en cas de collision) |
| `customer_id` | TEXT | FK → customers | Client du bon |
| `total` | INTEGER | NOT NULL | Σ(unit_price × quantity) − discount (recalculé par le serveur) |
| `discount` | INTEGER | NOT NULL, def. 0 | Remise |
| `amount_paid` | INTEGER | NOT NULL, def. 0 | Montant déjà payé (avance, solde) |
| `payment_method` | TEXT | `cash`\|`card`\|`transfer`\|`cheque`\|`credit` | |
| `payment_status` | TEXT | `paid`\|`partial`\|`unpaid` | Dérivé : `amount_paid` vs `total` |
| `status` | TEXT | `brouillon`\|`confirme`\|`livre`\|`annule` | Cycle de vie du bon |
| `sale_date` | TEXT (AAAA-MM-JJ) | NOT NULL | Date de la vente |
| `notes` | TEXT | NULL | |
| + colonnes de synchronisation communes | | | |

**Règle métier** : `status ∈ {confirme, livre}` ⇒ les motos des lignes passent
`status = 'sold'` ; retour en `brouillon`/`annule` ⇒ retour à `available` si aucune
autre vente active ne les détient. Appliqué **localement** (UX immédiate) et **côté
serveur** (source de vérité) à chaque push/pull.

## 5. `sale_items` — lignes de vente

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | TEXT (UUID) | PK | |
| `sale_id` | TEXT | FK → sales (CASCADE) | Bon de commande |
| `bike_id` | TEXT | FK → bikes | Moto vendue |
| `unit_price` | INTEGER | NOT NULL | **Prix verrouillé** à la vente (snapshot) |
| `quantity` | INTEGER | NOT NULL, > 0 | Quantité (généralement 1) |

Synchronisation : les lignes voyagent **dans le payload** de l'opération `sales`
(`payload.items[]`) et sont remplacées en bloc côté serveur — pas d'entité sync
séparée (évite les incohérences partielles).

## 6. `sale_counters` (serveur)

`year INTEGER PK, last INTEGER` — compteur annuel pour la numérotation
`BC-AAAA-NNNN` (allocation atomique dans la transaction du push).

## 7. `users` (serveur uniquement)

| Colonne | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | PK |
| `username` | TEXT UNIQUE | Identifiant de connexion |
| `password_hash` | TEXT | Haché bcrypt |
| `full_name` | TEXT | Nom complet affiché |
| `role` | TEXT | `admin` \| `seller` |
| + colonnes de temps / tombstone | | |

**RBAC** : seul le rôle `admin` contourne l'isolation par `owner_id` (accès à
l'intégralité des données) et peut supprimer des lignes, valider des conflits
(`force`) ou déclencher une sauvegarde serveur/Google Drive. Le rôle `seller`
est strictement confiné à ses propres données.

## 8. `audit_log` — journal d'audit (serveur uniquement)

Trace les actions sensibles (création, modification, suppression, validation de
conflit, sauvegarde Drive) pour l'analyse de sécurité.

| Colonne | Type | Description |
|---|---|---|
| `id` | INTEGER PK AUTO | Ordre chronologique |
| `at` | TEXT ISO-8601 UTC | Horodatage de l'action |
| `actor_id` | TEXT | Auteur (id utilisateur) |
| `actor_role` | TEXT | Rôle effectif au moment de l'action |
| `action` | TEXT | `create` \| `update` \| `delete` \| `force` \| `backup.drive` … |
| `entity` | TEXT | `bikes` \| `customers` \| `sales` \| … (NULL si global) |
| `entity_id` | TEXT | Identifiant de la ligne concernée |
| `owner_id` | TEXT | Propriétaire de la ligne au moment de l'action |
| `admin_access` | INTEGER (0/1) | 1 si l'action a été effectuée hors périmètre (admin) |
| `details` | TEXT (JSON) | Contexte additionnel (champs modifiés, taille…) |

Index : `at`, `(entity, entity_id)`, `actor_id`.

## 9. Tables locales de synchronisation (téléphone)

### `sync_queue` — file d'actions hors ligne
| Colonne | Type | Description |
|---|---|---|
| `id` | INTEGER PK AUTO | Ordre de traitement = ordre de saisie |
| `entity` | TEXT | `bikes` \| `customers` \| `sales` |
| `op` | TEXT | `create` \| `update` \| `delete` |
| `entity_id` | TEXT | UUID de l'entité concernée |
| `payload` | TEXT (JSON) | Ligne complète (ou `{id}` pour une suppression) |
| `client_ts` | TEXT ISO-8601 UTC | Horodatage de la modification locale — **clé LWW** |
| `force` | INTEGER (0/1) | Passe à 1 lors d'une validation administrative |
| `status` | TEXT | `pending` \| `conflict` \| `failed` |
| `attempts` | INTEGER | Tentatives (≥ 5 ⇒ `failed`, relance manuelle) |
| `last_error` | TEXT | Dernier message d'erreur |
| `created_at` | TEXT | |

### `sync_conflicts` — conflits à arbitrer
`queue_id` (PK → sync_queue CASCADE), `entity`, `entity_id`, `server_data` (JSON :
la version serveur en conflit), `detected_at`.

### `sync_meta` — clés/valeurs de synchronisation
| Clé | Valeur |
|---|---|
| `device_id` | Identifiant d'appareil stable (généré à la première ouverture) |
| `last_pull_since` | Horodatage du dernier pull effectué |
| `last_sync_at` | Fin du dernier cycle de synchronisation réussi |
| `sale_counter_YYYY` | Compteur local de numérotation des bons |

## 9. Conventions de synchronisation (les 6 colonnes magiques)

| Convention | Détail |
|---|---|
| `id` côté client | UUID v4 généré sur l'appareil → les créations hors ligne n'ont jamais de collision d'identifiant |
| `updated_at` ISO-8601 UTC | Comparaison **lexicographique** = comparaison chronologique (format fixe `Z`) |
| `created_at` | Jamais modifié après insertion |
| `version` | Incrément serveur à chaque changement (diagnostic, audit) |
| `deleted_at` (tombstone) | Suppression **logique** obligatoire : une vraie suppression serait invisible du pull |
| `device_id` | Tie-break déterministe en cas d'horodatages égaux (le plus grand gagne) |

## 10. Déploiement PostgreSQL

Le DDL de production est dans [sql/postgresql_schema.sql](sql/postgresql_schema.sql)
(types `UUID`, `TIMESTAMPTZ`, `BIGINT`, contraintes `CHECK`, index identiques).
L'application et l'API ne dépendent pas de SQLite proprement dit : l'interface de
l'adaptateur (`prepare/get/all/run/exec/pragma/transaction/close`) est triviale à
porter sur `pg` ou `Postgres.js`.
