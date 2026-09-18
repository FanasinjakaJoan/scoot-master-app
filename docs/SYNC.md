# 🔄 Logique de synchronisation offline-first — Scoot Master

Ce document explique le fonctionnement complet de la synchronisation hors ligne :
architecture, protocole push/pull, résolution de conflits, cas limites et garanties.

---

## 1. Principes

1. **La base locale est la source de vérité de l'UI.** Chaque écran lit la base
   SQLite locale ; aucune requête réseau n'est jamais sur le chemin de lecture
   → navigation instantanée, même hors ligne.
2. **Aucune écriture locale n'est perdue.** Toute mutation passe par les
   *repositories* (`mobile/src/data/local/repositories.ts`) qui, dans **une seule
   transaction**, (a) écrivent la ligne locale et (b) enfilent l'opération dans
   `sync_queue`.
3. **Le serveur arbitre.** Les horodatages du client (`client_ts`) ne sont jamais
   « imposés » : le serveur applique **Last-Write-Wins (LWW)** entre `client_ts`
   et le `updated_at` de sa copie, et renvoie les conflits pour arbitrage humain.
4. **Tombstones.** Tout est supprimé *logiquement* (`deleted_at`) : la
   suppression doit pouvoir voyager par le pull comme une modification ordinaire.

## 2. Cycle de synchronisation

```
        ┌────────────────────────────────────────────────────────────┐
        │                         TÉLÉPHONE                          │
        │                                                            │
 mutation UI ──▶ repositories ──▶ SQLite local  +  sync_queue       │
        │                                        │                   │
        │              déclencheurs (débounce)  │                   │
        │  • reconnexion réseau                  ▼                   │
        │  • retour au premier plan      MOTEUR (engine.ts)          │
        │  • après chaque écriture       ┌──────────────────┐        │
        │  • bouton « Synchroniser »      │ 1. PUSH          │        │
        └─────────────────────────────────┤   par lots de 200│───────┼──▶ POST /api/sync/push
                                          │ 2. PULL          │◀──────┼──┐
                                          │   depuis dernier │──────┼──▶ GET  /api/sync/pull?since=&cursor=
                                          │   horodatage,    │◀────────┘   (pagination par curseur)
                                          │   application    │
                                          │   LWW locale     │
                                          └────────┬─────────
                                                   │ meta: last_pull_since, last_sync_at
```

Déclencheurs de synchro (`AppStore.tsx`) :

| Événement | Délai |
|---|---|
| Réapparition du réseau (pendant une session connectée) | 1,2 s |
| Retour de l'app au premier plan | 0,6 s |
| Toute mutation locale | 0,8 s (débouncé) |
| Bouton « Synchroniser maintenant » | immédiat |
| Échec d'auth transitoire pendant un cycle (session gardée) | relance planifiée à 30 s |

Un verrou (`syncing`) empêche les cycles parallèles ; si le réseau coupe en cours
de push, le lot reste intact dans `sync_queue` (le serveur traite chaque lot dans
**une transaction** : le push est atomique côté serveur).

## 3. Protocole PUSH

**Requête** :

```jsonc
POST /api/sync/push
{
  "deviceId": "dev-3fa9c21b",
  "operations": [
    {
      "entity": "bikes",              // bikes | customers | sales
      "op": "update",                 // create | update | delete
      "id": "9c1f…",                  // UUID de l'entité (généré côté client)
      "payload": { "price": 2650000, "status": "available", … },  // ligne complète
      "clientTs": "2026-09-17T12:00:00.000Z",   // quand l'utilisateur a fait la modif
      "force": false                  // true = validation administrative
    }
  ]
}
```

**Traitement serveur** (transaction unique pour tout le lot) :

| Cas | Verdict |
|---|---|
| Opération sur une entité inconnue | `error` (rien d'autre n'est affecté) |
| Suppression d'une ligne absente | `ok` (idempotent) |
| Création / ligne absente du serveur | `ok` — insertion (le n° de bon de commande est alloué si absent) |
| `clientTs > updated_at(serveur)` | `ok` — application, `version+1`, `updated_at = clientTs` |
| `clientTs = updated_at(serveur)` | **Tie-break** : le `deviceId` le plus grand l'emporte (deterministe, converge quel que soit l'ordre) |
| `clientTs < updated_at(serveur)` | **`conflict`** — non appliqué, la version serveur est renvoyée dans le résultat |
| Modification sans aucun changement de champ | `ok` **idempotent** — pas de bump de version (élimine les faux conflits des effets de domaine miroirs) |
| `force: true` + rôle **admin** | LWW contourné → application |
| `force: true` + rôle `seller` | `force` ignoré → arbitrage LWW normal |

**Réponse** :

```jsonc
{
  "serverTime": "2026-09-17T13:05:01.000Z",
  "stats": { "total": 3, "ok": 2, "conflicts": 1, "errors": 0 },
  "results": [
    { "index": 0, "id": "…", "entity": "customers", "status": "ok", "server": { … } },
    { "index": 1, "id": "…", "entity": "bikes",     "status": "conflict",
      "server": { "price": 2900000, "updated_at": "2026-09-17T12:50:00Z", … } },
    { "index": 2, "id": "…", "entity": "sales",     "status": "ok",
      "saleNumber": "BC-2026-0005" }
  ]
}
```

**Traitement client** de chaque résultat :

- `ok` → suppression de l'opération de `sync_queue` ; pour une vente, le
  `saleNumber` définitif est aligné localement (sans ré-enfilement).
- `conflict` → l'opération passe en statut `conflict` et la version serveur est
  stockée dans `sync_conflicts` → l'écran **Sync** la présente.
- `error` → `attempts+1` ; ≥ 5 tentatives ⇒ `failed` (relance manuelle possible).

## 4. Protocole PULL

```
GET /api/sync/pull?since=2026-09-17T00:00:00.000Z[&cursor=<opaque>][&limit=500]
→ { serverTime, changes: [
     { entity, id, op: "upsert"|"delete", updatedAt, version, data }, … ],
    nextCursor: "…" | null }
```

- Le serveur renvoie les lignes avec `updated_at > since`, **y compris les
  tombstones** (`deleted_at > since` ⇒ `op: "delete"`).
- **Pagination par curseur clé** `(updated_at, id)` en base64 : impossible d'avoir
  des doublons ou des trous, même si plusieurs lignes partagent un horodatage.
- Le client n'applique un changement que s'il est **plus récent que sa copie
  locale** (même règle LWW, dans `applyServerChange`), puis met à jour
  `last_pull_since = serverTime`.

Conséquence : un appareil qui revient d'une longue pause tire **tout** ce qui a
bougé, et garde les modifications locales plus récentes.

## 5. Résolution des conflits

### 5.1 Règle par défaut — Last-Write-Wins
« La transaction la plus récente l'emporte » : comparée sur les horodatages de
modification. C'est simple, déterministe et sans blocage : **aucune donnée n'est
effacée sans visibilité** (le perdant reste visible dans l'UI de conflit).

### 5.2 Validation administrative
Dans l'écran **Sync**, chaque conflit propose :

- **« Conserver le serveur »** (tous rôles) : la version serveur remplace la
  version locale en attente ; l'opération est retirée de la file.
- **« Forcer ma version »** (**admin uniquement**) : l'opération est repoussée avec
  `force: true` ; le serveur n'accepte la force que si le jeton est bien celui d'un
  administrateur (rôle vérifié côté serveur, pas côté client).

### 5.3 Conflits « métier » courants
| Situation | Comportement |
|---|---|
| Deux appareils changent le prix de la même moto | Le plus récent l'emporte ; l'autre voit le conflit et arbitre |
| Un appareil vend une moto que l'autre vient de vendre | Le serveur n'empêche pas la double vente au push ; l'UI n'autorise que les motos `available` et l'effet de domaine remet en stock lors des annulations. L'admin vérifie via les historiques |
| Le serveur a déjà appliqué un effet de domaine (vente ⇒ moto `sold`) puis reçoit l'opération moto du même appareil | Règle d'**idempotence** : même état ⇒ `ok` sans conflit |
| Numéros de bon identiques (deux appareils hors ligne) | Le premier push conserve le n° ; le second est **ré-affecté** automatiquement (`BC-AAAA-NNNN` suivant) et le client aligne sa copie |

## 6. Cas limites

| Cas | Garantie |
|---|---|
| Coupure réseau en cours de push | Le lot serveur est transactionnel ; le client n'efface la file qu'après réception du `200` |
| App fermée/crashée entre l'écriture locale et le push | La file est sur disque (SQLite) : reprise au démarrage |
| Horloges d'appareils désynchronisées | LWW peut trancher « contre l'intuition » si un appareil a l'heure en avance ; le tie-break par `device_id` est déterministe ; les conflits restent visibles et arbitrables (c'est le rôle de l'écran Sync) |
| Appareil absent 3 mois | `since` = dernier `serverTime` connu → pull complet des changements, curseur inclus |
| Suppression côté serveur d'une ligne modifiée localement | Le tombstone plus récent gagne au pull ; la modification locale restante devient un conflit au prochain push |
| Double push du même lot (réseau instable, double envoi) | L'idempotence (même état) et la LWW rendent le re-push sans effet de bord |
| Lot très volumineux | Découpage côté client par 200 opérations (max serveur : 500) |
| Échec serveur répété (contrainte, FK) | `error` avec message ; 5 tentatives ⇒ `failed` + relance manuelle depuis l'écran Sync |
| **Erreur d'authentification (401/403) pendant PUSH ou PULL** | La session est **maintenue pendant la transmission** : renouvellement proactif entre deux lots/pages quand le jeton approche de l'échéance, et sur 401 en cours de route UN renouvellement (vol unique partagé) puis rejeu de la requête fautive avec le jeton frais — lot push rejoué à l'identique, page pull rejouée au même curseur. Si l'échec persiste, la file n'est **jamais purgée** : opérations `pending` marquées « Suspendu : réauthentification requise » sans consommer de tentative, curseur `last_pull_since` intact. Refus EXPLICITE du serveur (`authRefused`) ⇒ écran de connexion ; panne TRANSITOIRE (réseau, 5xx) ⇒ **session gardée** (utilisateur connecté, relance à 30 s + reprise auto) |
| **Session expirée au démarrage / en arrière-plan** | La session est **maintenue jusqu'à la déconnexion volontaire**. Le client relit le jeton dans le stockage sécurisé, le renouvelle via `POST /api/auth/refresh` à l'approche de l'échéance (keep-alive toutes les 15 min, au retour au premier plan, avant chaque transmission et pendant celle-ci). Un jeton expiré depuis des semaines reste renouvelable (grâce miroir des 60 jours serveur) : l'horloge de l'appareil ne déconnecte jamais, seul un refus serveur le fait — **données locales et file toujours intactes** |
| **Téléversement de sauvegarde refusé (401/403)** | La demande est mémorisée (`pending_backup_upload`) et **re-tentée automatiquement** après la reconnexion, avec confirmation à l'utilisateur |

## 7. Exemple chronologique complet

```
T0  phone-A (hors ligne) : crée le client C1            → queue[A1] create customers C1  (ts 08:00)
T1  phone-A (hors ligne) : crée la moto B1              → queue[A2] create bikes B1      (ts 08:05)
T2  phone-A (hors ligne) : bon de commande S1 (conf.)   → queue[A3] create sales S1      (ts 08:10)
                                     + queue[A4] update bikes B1 → status=sold (ts 08:10)  (effet de domaine)
T3  admin (en ligne, API)  : modifie le prix de B1      → serveur B1.updated_at = 09:00, price 2900
T4  phone-A retrouve le réseau :
      PUSH [A1..A4] → A1 ok · A2 CONFLICT (08:05 < 09:00) · A3 ok (BC-2026-0001) · A4 ok idempotent*
      PULL since=…  → B1 (price 2900, updated 09:00) remplace la copie locale (09:00 > 08:05)
      UI : écran Sync montre le conflit B1
      Admin choisit « Conserver le serveur » → B1 locale = 2900, file vidée
   * A4 est idempotent : le serveur a déjà mis B1 en sold via l'effet de domaine de A3.
```

## 8. Pourquoi ces choix ?

- **LWW + tombstones** : le standard des bases répliquées (CRDT-lite) ; convergence
  sans coordination, pas de blocage, idéal pour des tablettes de vente sur le terrain.
- **File locale transactionnelle** : l'équivalent d'un journal de transactions local ;
  « écriture + enfilement » atomiques ⇒ aucune action silencieusement perdue.
- **Arbitrage humain au choix** : la « validation administrative » couvre les cas où
  la règle automatique est insuffisante (prix discutés, double vente), sans jamais
  casser le flux des vendeurs.
- **Numérotation servie par le serveur** : la contrainte d'unicité des bons de
  commande est une contrainte *métier forte* ; elle ne peut pas reposer sur deux
  compteurs locaux — le serveur en est l'autorité et ré-affecte les collisions.
