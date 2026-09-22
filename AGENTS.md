# AGENTS.md — Scoot Master

Application mobile offline-first (React Native/Expo) + backend Node/Express/SQLite,
déployée sur Render (deux Web Services : `scoot-master-api` et `scoot-master-web`).

## Commandes

- Backend : `cd backend && npm test` (tests `node --test`) — `npm start` lance l'API sur `:4000`.
- Mobile : `cd mobile && npx jest` et `npx tsc --noEmit`.
- Aperçu web local : `PORT=12000 API_TARGET=http://127.0.0.1:4000 node deploy/web-server.js`.

## Architecture de synchronisation (à connaître avant tout debug)

L'app web appelle l'API en **chemins relatifs** (`/api/...`) ;
`deploy/web-server.js` joue le rôle de reverse-proxy vers le backend, ce qui
évite le CORS en développement.

En production Render, `API_TARGET` est censé venir du réseau privé
(`fromService: hostport`) mais peut en pratique résoudre vers l'**URL publique**
`https://scoot-master-api.onrender.com`.

## Pièges déjà rencontrés (ne pas les re-découvrir)

1. **Port implicite `https`** — `new URL('https://hote').port` vaut `''`, pas `443`.
   Écrire `port || 80` ouvre une connexion **en clair sur le port 80** vers une
   cible HTTPS ; l'apex répond `301`. Utiliser `transportFor()` dans
   `deploy/web-server.js`. Test : `backend/tests/web-proxy.test.js`.

2. **`Authorization` perdu sur redirection cross-origin** — la spécification Fetch
   impose de supprimer l'en-tête `Authorization` quand une redirection change
   d'origine, et un `POST` redirigé en `301` devient un `GET`. Un proxy ne doit
   donc **jamais** renvoyer une redirection cross-origin au navigateur : il suit
   la redirection lui-même. Cela se manifeste côté utilisateur par une erreur
   **403** (ou 401) alors que l'API et les identifiants sont corrects.

3. **403 silencieux dans le moteur de sync** — `mobile/src/data/sync/engine.ts`
   traite 401/403 comme une « interruption temporaire » et l'avale, tandis que
   `StatusPill` affiche « Données à jour ». Un 403 peut donc masquer une synchro
   totalement rompue : vérifier l'état réel, pas l'indicateur.

4. **GITHUB_TOKEN en lecture seule dans les Actions** — tout job qui publie une
   Release (`softprops/action-gh-release`) doit déclarer
   `permissions: contents: write`, sinon « 403 Resource not accessible by
   integration » et aucune Release n'est créée (donc URL APK en 404).

## Vérifications utiles

```bash
# la réponse du proxy web doit être 200, jamais 301
curl -s -o /dev/null -D - https://scoot-master-web.onrender.com/api/health | grep -i '^HTTP\|location'
# le jeton doit traverser la redirection (200 + changes non vides)
curl -s ... /api/sync/pull?since=1970-01-01T00:00:00.000Z -H "Authorization: Bearer $T"
```

`backend/tests/web-proxy.test.js` couvre la régression du proxy (301 suivi,
`Authorization` conservé, pas de boucle, 502 si backend injoignable).
