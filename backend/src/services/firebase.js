'use strict';

const https = require('https');
const crypto = require('crypto');

/**
 * Accès Firebase (Cloud Storage + export natif Firestore) pour la sauvegarde.
 *
 * Le SDK `firebase-admin` n'est requis QUE si la sauvegarde est réellement
 * activée : une API qui n'utilise pas Firebase démarre donc sans la dépendance.
 * `admin` et `bucket` sont injectables afin que les tests exercent le vrai code
 * de sauvegarde contre un double en mémoire, sans réseau ni credentials.
 */

const OAUTH_HOST = 'oauth2.googleapis.com';
const FIRESTORE_HOST = 'firestore.googleapis.com';

/** Jeton OAuth du compte de service mis en cache jusqu'à son échéance. */
let cachedToken = null;

/**
 * Construit le JWT « assertion » signé RS256 puis l'échange contre un jeton
 * d'accès Google. Implémenté avec `node:crypto` pour ne pas dépendre d'une
 * bibliothèque supplémentaire (l'export Firestore passe par l'API REST).
 */
async function fetchAccessToken(serviceAccount, { request = httpsRequest, now = Date.now } = {}) {
  if (cachedToken && cachedToken.expiresAt - 60000 > now()) return cachedToken.token;
  const iat = Math.floor(now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: serviceAccount.clientEmail,
    scope: 'https://www.googleapis.com/auth/devstorage.read_write https://www.googleapis.com/auth/datastore',
    aud: `https://${OAUTH_HOST}/token`,
    iat,
    exp: iat + 3600,
  }));
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(serviceAccount.privateKey);
  const assertion = `${header}.${claims}.${base64url(signature)}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }).toString();

  const res = await request({
    host: OAUTH_HOST,
    method: 'POST',
    path: '/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const parsed = safeJson(res.body);
  if (res.statusCode !== 200 || !parsed.access_token) {
    throw new Error(`Authentification Google refusée (${res.statusCode}): ${parsed.error_description || parsed.error || res.body}`);
  }
  cachedToken = { token: parsed.access_token, expiresAt: now() + parsed.expires_in * 1000 };
  return cachedToken.token;
}

/** Requête HTTPS minimale (utilisée pour OAuth et l'export Firestore). */
function httpsRequest({ host, method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

/**
 * Crée le service Firebase.
 *
 * @param {object} options
 * @param {object} options.serviceAccount `{ projectId, clientEmail, privateKey }`
 * @param {object} options.backup configuration de sauvegarde (`bucket`, `prefix`…)
 * @param {object} [options.admin]  SDK firebase-admin (injecté en test)
 * @param {object} [options.bucket] bucket Storage déjà construit (injecté en test)
 * @param {Function} [options.request] transport HTTPS (injecté en test)
 */
function createFirebaseService({ serviceAccount, backup, admin, bucket, request } = {}) {
  let appInstance = null;
  let bucketInstance = bucket || null;

  /**
   * Surface normalisée du SDK, quelle que soit la version installée.
   * `firebase-admin` v10+ expose l'API modulaire (`firebase-admin/app`,
   * `firebase-admin/storage`) ; la v14 a retiré les alias historiques
   * `admin.credential` / `admin.storage`, donc on n'y compte pas.
   * Un objet `admin` injecté (tests) peut fournir directement `cert`,
   * `initializeApp`, `getApps`, `getApp` et `getStorage`.
   */
  function loadAdmin() {
    if (admin) return admin;
    try {
      const app = require('firebase-admin/app');
      const storage = require('firebase-admin/storage');
      return {
        cert: app.cert,
        initializeApp: app.initializeApp,
        getApps: app.getApps,
        getApp: app.getApp,
        getStorage: storage.getStorage,
      };
    } catch {
      throw new Error(
        "Sauvegarde Firebase activée mais le paquet 'firebase-admin' est absent : exécutez `npm install firebase-admin` dans backend/."
      );
    }
  }

  function getBucket() {
    if (bucketInstance) return bucketInstance;
    const sdk = loadAdmin();
    if (!appInstance) {
      appInstance = sdk.getApps().length
        ? sdk.getApp()
        : sdk.initializeApp({
            credential: sdk.cert({
              projectId: serviceAccount.projectId,
              clientEmail: serviceAccount.clientEmail,
              privateKey: serviceAccount.privateKey,
            }),
          });
    }
    bucketInstance = sdk.getStorage(appInstance).bucket(backup.bucket);
    return bucketInstance;
  }

  /** Téléverse un buffer dans le bucket, avec métadonnées personnalisées. */
  async function uploadBuffer(destPath, buffer, { contentType = 'application/json', metadata = {} } = {}) {
    await getBucket().file(destPath).save(buffer, {
      contentType,
      resumable: false,
      metadata: { metadata, cacheControl: 'private, max-age=0' },
    });
    return destPath;
  }

  /** Télécharge un objet du bucket (Buffer). */
  async function downloadBuffer(srcPath) {
    const [contents] = await getBucket().file(srcPath).download();
    return contents;
  }

  /** Liste les objets sous le préfixe de sauvegarde, du plus récent au plus ancien. */
  async function listFiles(prefix = backup.prefix) {
    const [files] = await getBucket().getFiles({ prefix, autoPaginate: true });
    return files
      .map((f) => ({
        path: f.name,
        size: Number((f.metadata && f.metadata.size) || 0),
        updatedAt: (f.metadata && (f.metadata.updated || f.metadata.timeCreated)) || null,
        metadata: (f.metadata && f.metadata.metadata) || {},
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async function deleteFile(path) {
    await getBucket().file(path).delete({ ignoreNotFound: true });
  }

  /**
   * Supprime les sauvegardes excédentaires (rotation). Ne touche qu'aux objets
   * portant le marqueur applicatif, pour ne jamais effacer un fichier étranger
   * déposé dans le même dossier.
   */
  async function pruneBackups(keep) {
    const files = (await listFiles()).filter((f) => f.metadata && f.metadata.app === 'scoot-master');
    const stale = files.slice(keep);
    for (const file of stale) await deleteFile(file.path);
    return stale.map((f) => f.path);
  }

  /**
   * Déclenche un export natif Firestore → GCS (API REST
   * `projects.databases.exportDocuments`). Utilisé lorsque les données vivent
   * dans Firestore et non dans une base locale.
   */
  async function exportFirestore(collectionIds, outputPrefix = backup.prefix, deps = {}) {
    const req = deps.request || request || httpsRequest;
    const token = await fetchAccessToken(serviceAccount, { request: req, now: deps.now });
    const body = JSON.stringify({
      outputUriPrefix: `gs://${backup.bucket}/${outputPrefix}firestore`,
      ...(collectionIds && collectionIds.length ? { collectionIds } : {}),
    });
    const res = await req({
      host: FIRESTORE_HOST,
      method: 'POST',
      path: `/v1/projects/${serviceAccount.projectId}/databases/(default):exportDocuments`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });
    const parsed = safeJson(res.body);
    if (res.statusCode !== 200) {
      throw new Error(`Export Firestore refusé (${res.statusCode}): ${parsed.error?.message || res.body}`);
    }
    return parsed;
  }

  return {
    getBucket,
    uploadBuffer,
    downloadBuffer,
    listFiles,
    deleteFile,
    pruneBackups,
    exportFirestore,
  };
}

/** Réinitialise le cache de jeton OAuth (utilisé par les tests). */
function _resetTokenCache() { cachedToken = null; }

module.exports = { createFirebaseService, fetchAccessToken, httpsRequest, _resetTokenCache };
