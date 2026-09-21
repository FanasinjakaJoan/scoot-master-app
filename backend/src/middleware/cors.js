'use strict';

/**
 * CORS de l'API Scoot Master.
 *
 * L'API est consommée depuis PLUSIEURS origines : l'app web servie par
 * `deploy/web-server.js` (ou par le proxy Metro en développement) et — surtout —
 * l'app web déployée sur Render, qui appelle l'API en **cross-origin** dès que
 * l'edge de l'hébergeur redirige `/api/*` vers le service d'API (constaté en
 * production : `301`/`307` vers `https://scoot-master-api.onrender.com/...`).
 * Toute réponse sans `Access-Control-Allow-Origin` est alors bloquée par le
 * navigateur : la synchronisation (push/pull), le téléversement de sauvegarde
 * et la connexion échouent, ce que l'utilisateur voit comme une erreur `403`.
 *
 * L'authentification se fait par en-tête `Authorization: Bearer <JWT>` et
 * JAMAIS par cookie : il n'existe donc aucune crédential ambiante qu'un site
 * tiers pourrait rejouer. Refléter l'`Origin` de la requête n'ouvre aucune
 * capacité CSRF — contrairement au cas « cookie de session + ACAO reflété ».
 * On reflète donc systématiquement l'origine, plutôt que de dépendre d'une
 * liste blanche qui, mal configurée (valeur vide, URL avec `/` final, origine
 * différente de celle servie), coupait silencieusement toute la synchronisation.
 *
 * `CORS_ORIGIN` reste exploité comme liste restrictive optionnelle :
 * - vide ou `*`      → toutes les origines (défaut, comportement reflété) ;
 * - liste d'origines → ces origines sont servies, et toute autre origine aussi
 *   (voir `CORS_STRICT` ci-dessous) afin de ne jamais casser le client.
 */

/** En-têtes acceptés sur les requêtes de l'app (JWT + JSON). */
const ALLOWED_HEADERS = 'Authorization, Content-Type';
/** Verbes utilisés par l'app (push/pull compris). */
const ALLOWED_METHODS = 'GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS';
/** Durée de mise en cache du pré-vol par le navigateur (24 h). */
const MAX_AGE_SECONDS = '86400';

/**
 * Applique les en-têtes CORS puis répond immédiatement au pré-vol.
 *
 * @param {string[]|'*'} allowedOrigins liste `CORS_ORIGIN` normalisée, ou `'*'`
 * @param {{ strict?: boolean, warn?: (message: string) => void }} [options]
 *   `strict: true` refuse les origines hors liste (aucun en-tête émis ⇒ le
 *   navigateur bloque). Par défaut on reflète malgré tout, pour ne jamais
 *   rejouer l'incident de synchronisation.
 */
function corsMiddleware(allowedOrigins, options = {}) {
  const { strict = false, warn } = options;
  const isOpen = allowedOrigins === '*';
  let warned = false;

  return (req, res, next) => {
    const origin = req.headers.origin;

    if (origin) {
      const listed = isOpen || allowedOrigins.includes(origin);
      if (listed || !strict) {
        // `Vary: Origin` : indispensable pour ne pas servir à un client la
        // réponse mise en cache pour une autre origine.
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
        res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
        res.setHeader('Access-Control-Max-Age', MAX_AGE_SECONDS);
        if (!listed && !warned) {
          warned = true;
          // Une seule alerte : éviter de saturer les journaux à chaque requête.
          if (warn) warn(`Origine « ${origin} » absente de CORS_ORIGIN — requête servie quand même (auth par en-tête, sans cookie).`);
        }
      }
    } else {
      // Requête hors navigateur (curl, tests, sondes de santé) : `*` suffit.
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    // Pré-vol : aucune route métier ne doit être traversée.
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

module.exports = { corsMiddleware, ALLOWED_HEADERS, ALLOWED_METHODS };