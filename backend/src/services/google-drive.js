'use strict';

/**
 * Client minimal Google Drive via un **compte de service** (Service Account).
 *
 * Aucune dépendance `googleapis` : on signe nous-mêmes un JWT RS256
 * (`crypto`), on l'échange contre un jeton d'accès OAuth2, puis on téléverse
 * le fichier via l'API Drive v3 (`files.create`, upload multipart).
 *
 * Ce choix garde le backend sans dépendance native/lourde, conformément au
 * reste du projet (adaptateur `node:sqlite`, mini-lecteur `.env`, …).
 *
 * Variables d'environnement utilisées (voir .env.example) :
 *   GOOGLE_CLIENT_EMAIL   e-mail du compte de service
 *   GOOGLE_PRIVATE_KEY    clé privée PEM (les `\n` littéraux sont restaurés)
 *   GOOGLE_DRIVE_FOLDER_ID  dossier cible (à partager avec le compte de service)
 *
 * Note sécurité : le compte de service n'a accès qu'au dossier qui lui a été
 * explicitement partagé. Il faut donc partager le dossier Drive cible avec
 * `GOOGLE_CLIENT_EMAIL` (éditeur) — sinon l'API répond 403/404.
 */

const crypto = require('crypto');
const { config } = require('../config');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Encode un objet en base64url (JWT sans dépendance). */
function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Construit et signe un JWT d'assertion de compte de service (RS256). */
function signServiceAssertion({ clientEmail, privateKey, tokenUri, now = Math.floor(Date.now() / 1000) }) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: DRIVE_SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

class GoogleDriveError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'GoogleDriveError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Client Drive. Les URL et la fonction `fetch` sont injectables pour les tests
 * (on peut ainsi vérifier la signature/les appels sans réseau réel).
 */
class GoogleDriveClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.clientEmail]
   * @param {string} [opts.privateKey]
   * @param {string} [opts.folderId]
   * @param {Function} [opts.fetchImpl] remplace `globalThis.fetch`
   */
  constructor(opts = {}) {
    this.clientEmail = opts.clientEmail ?? config.backup.googleClientEmail;
    this.privateKey = opts.privateKey ?? config.backup.googlePrivateKey;
    this.folderId = opts.folderId ?? config.backup.googleDriveFolderId;
    this.tokenUri = opts.tokenUri ?? config.backup.tokenUri;
    this.driveApiBase = (opts.driveApiBase ?? config.backup.driveApiBase).replace(/\/$/, '');
    this.uploadApiBase = (opts.uploadApiBase ?? config.backup.uploadApiBase).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this._token = null;
    this._tokenExpiry = 0;
  }

  get configured() {
    return Boolean(this.clientEmail && this.privateKey);
  }

  /** Obtient (et met en cache) un jeton d'accès OAuth2 du compte de service. */
  async accessToken() {
    if (!this.configured) throw new GoogleDriveError('Compte de service Google non configuré.', 0);
    const nowSec = Math.floor(Date.now() / 1000);
    if (this._token && nowSec < this._tokenExpiry - 60) return this._token;

    const assertion = signServiceAssertion({
      clientEmail: this.clientEmail, privateKey: this.privateKey, tokenUri: this.tokenUri, now: nowSec,
    });
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    const res = await this.fetchImpl(this.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* réponse non JSON */ }
    if (!res.ok || !json || !json.access_token) {
      throw new GoogleDriveError('Échec d\u2019obtention du jeton Google (vérifier le compte de service).', res.status, json || text);
    }
    this._token = json.access_token;
    this._tokenExpiry = nowSec + Number(json.expires_in || 3600);
    return this._token;
  }

  /** Téléverse un contenu (Buffer/string) dans le dossier configuré. */
  async uploadFile({ name, content, mimeType = 'application/json', folderId }) {
    const token = await this.accessToken();
    const parent = folderId || this.folderId || undefined;
    const metadata = { name, ...(parent ? { parents: [parent] } : {}) };
    const boundary = 'scootmaster' + crypto.randomBytes(8).toString('hex');
    const payload = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');

    // Requête multipart : métadonnées JSON puis contenu binaire.
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
      Buffer.from(JSON.stringify(metadata), 'utf8'),
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      payload,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const url = `${this.uploadApiBase}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* réponse non JSON */ }
    if (!res.ok || !json || !json.id) {
      throw new GoogleDriveError('Échec du téléversement vers Google Drive.', res.status, json || text);
    }
    return { id: json.id, name: json.name, webViewLink: json.webViewLink || null };
  }

  /** Liste les fichiers de sauvegarde du dossier (diagnostic admin). */
  async listFiles({ folderId, max = 50 } = {}) {
    const token = await this.accessToken();
    const parent = folderId || this.folderId;
    const q = parent ? `'${parent}' in parents and trashed = false` : 'trashed = false';
    const url = `${this.driveApiBase}/files?q=${encodeURIComponent(q)}`
      + `&orderBy=createdTime desc&pageSize=${Math.max(1, Math.min(Number(max) || 50, 1000))}`
      + '&fields=files(id,name,size,createdTime,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true';
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* réponse non JSON */ }
    if (!res.ok || !json) {
      throw new GoogleDriveError('Échec de la lecture du dossier Google Drive.', res.status, json || text);
    }
    return json.files || [];
  }
}

module.exports = { GoogleDriveClient, GoogleDriveError, signServiceAssertion };
