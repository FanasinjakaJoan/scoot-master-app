#!/usr/bin/env node
/**
 * Vérification de bout en bout de l'API Scoot Master — synchronisation et
 * sauvegarde, contre un backend RÉELLEMENT démarré (base SQLite + seed).
 *
 *   cd backend && npm start            # dans un autre terminal
 *   npm run check:api                  # ou : node scripts/check-api.mjs
 *   BASE=https://scoot-master-api.onrender.com npm run check:api
 *
 * Complémentaire de `npm test` (base en mémoire) : ici on traverse le vrai
 * serveur HTTP, le vrai moteur SQLite et le vrai stockage de sauvegardes.
 * Couvre : auth/rôles, CRUD, push/pull + curseur, LWW (gain/conflit), force
 * admin, idempotence, ventes (total, effets de domaine, renumérotation,
 * stabilité du numéro de bon), tombstones, exports JSON/CSV, sauvegarde
 * (téléchargement, téléversement, liste admin).
 *
 * Sortie : 0 = tout est vert, 1 = au moins un contrôle en échec.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:4000';
let pass = 0, fail = 0;
const results = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function req(method, path, { token, body, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: raw ? text : (text ? JSON.parse(text) : null) };
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));

// ---------- 1. santé & auth ----------
const health = await req('GET', '/api/health');
check('GET /api/health', health.status === 200 && health.body.ok === true, JSON.stringify(health.body));

const badLogin = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'nope' } });
check('login mauvais mot de passe rejeté', badLogin.status === 401, `status=${badLogin.status}`);

const admin = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
check('login admin/admin123', admin.status === 200 && !!admin.body?.token, `rôle=${admin.body?.user?.role}`);
const seller = await req('POST', '/api/auth/login', { body: { username: 'vendeur', password: 'vendeur123' } });
check('login vendeur/vendeur123', seller.status === 200 && seller.body?.user?.role === 'seller');
const tAdmin = admin.body.token, tSeller = seller.body.token;

const noAuth = await req('GET', '/api/bikes');
check('GET /api/bikes sans jeton refusé', noAuth.status === 401, `status=${noAuth.status}`);

const me = await req('GET', '/api/auth/me', { token: tAdmin });
check('GET /api/auth/me', me.status === 200 && me.body?.user?.username === 'admin', `username=${me.body?.user?.username}`);

// ---------- 2. CRUD catalogue ----------
const bikes0 = await req('GET', '/api/bikes', { token: tAdmin });
check('GET /api/bikes (seed)', bikes0.status === 200 && Array.isArray(bikes0.body?.data ?? bikes0.body?.items ?? bikes0.body),
  `${(bikes0.body?.data ?? bikes0.body?.items ?? bikes0.body ?? []).length} motos`);

const bikeId = uuid();
const created = await req('POST', '/api/bikes', {
  token: tAdmin,
  body: { id: bikeId, brand: 'Honda', model: 'CBR E2E', year: 2021, price: 4500000, status: 'available' },
});
check('POST /api/bikes (création REST)', created.status === 201 || created.status === 200, `status=${created.status}`);

// ---------- 3. SYNC push (création hors ligne) ----------
const syncBikeId = uuid();
const pushCreate = await req('POST', '/api/sync/push', {
  token: tAdmin,
  body: {
    deviceId: 'device-e2e-A',
    operations: [{
      entity: 'bikes', op: 'create', id: syncBikeId, clientTs: iso(),
      payload: { brand: 'Yamaha', model: 'Sync Test', year: 2022, price: 3000000, status: 'available', photos: [] },
    }],
  },
});
check('POST /api/sync/push create', pushCreate.status === 200 && pushCreate.body?.results?.[0]?.status === 'ok',
  `status=${pushCreate.body?.results?.[0]?.status}`);

// ---------- 4. SYNC pull (curseur + propagation) ----------
const pull1 = await req('GET', '/api/sync/pull?since=' + encodeURIComponent('1970-01-01T00:00:00.000Z'), { token: tAdmin });
const pulledIds = (pull1.body?.changes || []).map((c) => c.id);
check('GET /api/sync/pull contient la moto poussée', pulledIds.includes(syncBikeId),
  `${(pull1.body?.changes || []).length} changements, nextCursor=${pull1.body?.nextCursor ? 'oui' : 'non'}`);

const pullFiltered = await req('GET', '/api/sync/pull?since=' + encodeURIComponent(iso(60000)), { token: tAdmin });
check('pull depuis un `since` futur = vide', (pullFiltered.body?.changes || []).length === 0);

// pagination par curseur
const pullSmall = await req('GET', '/api/sync/pull?since=' + encodeURIComponent('1970-01-01T00:00:00.000Z') + '&limit=2', { token: tAdmin });
let seen = new Set((pullSmall.body?.changes || []).map((c) => c.id));
let cursor = pullSmall.body?.nextCursor;
let pages = 1;
while (cursor && pages < 30) {
  const p = await req('GET', '/api/sync/pull?since=' + encodeURIComponent('1970-01-01T00:00:00.000Z') + '&limit=2&cursor=' + encodeURIComponent(cursor), { token: tAdmin });
  (p.body?.changes || []).forEach((c) => seen.add(c.id));
  cursor = p.body?.nextCursor;
  pages++;
}
check('pagination par curseur (limite 2)', pages > 1 && seen.size === (pull1.body?.changes || []).length,
  `${pages} pages, ${seen.size} entités uniques vs ${(pull1.body?.changes || []).length}`);

// ---------- 5. LWW : mise à jour plus récente gagne ----------
const newer = iso(5000);
const pushNewer = await req('POST', '/api/sync/push', {
  token: tAdmin,
  body: {
    deviceId: 'device-e2e-A',
    operations: [{ entity: 'bikes', op: 'update', id: syncBikeId, clientTs: newer, payload: { price: 3500000 } }],
  },
});
check('push update plus récent appliqué (LWW)', pushNewer.body?.results?.[0]?.status === 'ok'
  && pushNewer.body.results[0].server?.price === 3500000, `prix=${pushNewer.body?.results?.[0]?.server?.price}`);

// ---------- 6. LWW : mise à jour plus ancienne → conflit ----------
const pushOlder = await req('POST', '/api/sync/push', {
  token: tAdmin,
  body: {
    deviceId: 'device-e2e-B',
    operations: [{ entity: 'bikes', op: 'update', id: syncBikeId, clientTs: iso(-60000), payload: { price: 1111111 } }],
  },
});
check('push plus ancien → conflit LWW', pushOlder.body?.results?.[0]?.status === 'conflict'
  && pushOlder.body.results[0].server?.price === 3500000,
  `status=${pushOlder.body?.results?.[0]?.status}, prix serveur=${pushOlder.body?.results?.[0]?.server?.price}`);

// ---------- 7. force : réservé admin ----------
// Le vendeur opère sur SA propre moto (isolation par `owner_id`). On la crée
// d'abord, puis on pousse une mise à jour plus ancienne → conflit LWW.
const sellerBikeId = uuid();
const pushSellerBike = await req('POST', '/api/sync/push', {
  token: tSeller,
  body: {
    deviceId: 'device-e2e-S',
    operations: [{
      entity: 'bikes', op: 'create', id: sellerBikeId, clientTs: iso(),
      payload: { brand: 'Suzuki', model: 'V-Strom', year: 2020, price: 5000000, status: 'available' },
    }],
  },
});
check('push création par le vendeur (propriété forcée)', pushSellerBike.body?.results?.[0]?.status === 'ok',
  `status=${pushSellerBike.body?.results?.[0]?.status}`);

const forceSeller = await req('POST', '/api/sync/push', {
  token: tSeller,
  body: {
    deviceId: 'device-e2e-S',
    operations: [{ entity: 'bikes', op: 'update', id: sellerBikeId, clientTs: iso(-60000), force: true, payload: { price: 999 } }],
  },
});
check('force ignoré pour un vendeur', forceSeller.body?.results?.[0]?.status === 'conflict',
  `status=${forceSeller.body?.results?.[0]?.status}`);

const forceAdmin = await req('POST', '/api/sync/push', {
  token: tAdmin,
  body: {
    deviceId: 'device-e2e-S',
    operations: [{ entity: 'bikes', op: 'update', id: sellerBikeId, clientTs: iso(-60000), force: true, payload: { price: 2222222 } }],
  },
});
check('force admin applique sa version', forceAdmin.body?.results?.[0]?.status === 'ok'
  && forceAdmin.body.results[0].server?.price === 2222222, `prix=${forceAdmin.body?.results?.[0]?.server?.price}`);

// ---------- 8. idempotence (pas de faux conflit) ----------
// Même valeur que l'état serveur courant de la moto admin (3500000) → idempotent.
const idem = await req('POST', '/api/sync/push', {
  token: tAdmin,
  body: {
    deviceId: 'device-e2e-B',
    operations: [{ entity: 'bikes', op: 'update', id: syncBikeId, clientTs: iso(-120000), payload: { price: 3500000 } }],
  },
});
check('opération identique = idempotente (ok)', idem.body?.results?.[0]?.status === 'ok'
  && idem.body.results[0].idempotent === true, `idempotent=${idem.body?.results?.[0]?.idempotent}`);

// ---------- 8b. isolation : un vendeur ne voit pas les données de l'admin ----------
const sellerPull = await req('GET', '/api/sync/pull?since=' + encodeURIComponent('1970-01-01T00:00:00.000Z'), { token: tSeller });
const sellerSeesAdminBike = (sellerPull.body?.changes || []).some((c) => c.id === syncBikeId);
check('pull vendeur exclut les données de l\u2019admin (RLS)', !sellerSeesAdminBike,
  `${(sellerPull.body?.changes || []).length} changements visibles pour le vendeur`);
const sellerReadAdminBike = await req('GET', '/api/bikes/' + syncBikeId, { token: tSeller });
check('lecture d\u2019une moto d\u2019autrui refusée (404)', sellerReadAdminBike.status === 404,
  `status=${sellerReadAdminBike.status}`);

// ---------- 9. ventes + effets de domaine (périmètre vendeur) ----------
// Le vendeur ne peut vendre que SON stock à SES clients → on crée un client vendeur.
const sellerCustomer = await req('POST', '/api/customers', {
  token: tSeller,
  body: { first_name: 'Client', last_name: 'E2E Vendeur', phone: '+261 34 00 00 09' },
});
const customerId = sellerCustomer.body?.customer?.id ?? sellerCustomer.body?.id;
check('client créé par le vendeur (propriété forcée)', !!customerId,
  `client=${customerId ? customerId.slice(0, 8) + '…' : 'aucun'}`);
const adminNow = await req('GET', '/api/customers', { token: tAdmin });
const sellerOwnCustomerIds = new Set(
  (await req('GET', '/api/customers', { token: tSeller })).body?.items?.map((c) => c.id) || []
);
const foreignCustomer = (adminNow.body?.items ?? []).find((c) => !sellerOwnCustomerIds.has(c.id));
check('isolation clients : le vendeur voit moins de clients que l\u2019admin',
  (adminNow.body?.items?.length || 0) > sellerOwnCustomerIds.size,
  `${adminNow.body?.items?.length} (admin) vs ${sellerOwnCustomerIds.size} (vendeur)`);
const sellerReadAdminCustomer = await req('GET', '/api/customers/' + foreignCustomer?.id, { token: tSeller });
check('lecture d\u2019un client d\u2019autrui refusée (404)', sellerReadAdminCustomer.status === 404,
  `status=${sellerReadAdminCustomer.status}`);

const saleId = uuid();
const pushSale = await req('POST', '/api/sync/push', {
  token: tSeller,
  body: {
    deviceId: 'device-e2e-A',
    operations: [{
      entity: 'sales', op: 'create', id: saleId, clientTs: iso(),
      payload: {
        customer_id: customerId, status: 'confirme', sale_date: iso(),
        discount: 100000, amount_paid: 500000,
        items: [{ id: uuid(), bike_id: sellerBikeId, unit_price: 2222222, quantity: 1 }],
      },
    }],
  },
});
const saleRes = pushSale.body?.results?.[0];
check('push vente confirmée', saleRes?.status === 'ok', `saleNumber=${saleRes?.saleNumber}`);
check('total recalculé (prix − remise)', saleRes?.server?.total === 2222222 - 100000,
  `total=${saleRes?.server?.total}`);
check('payment_status = partial', saleRes?.server?.payment_status === 'partial',
  `${saleRes?.server?.payment_status}`);
const bikeAfterSale = await req('GET', '/api/bikes/' + sellerBikeId, { token: tSeller });
check('effet de domaine : moto passée en « vendue »',
  (bikeAfterSale.body?.status ?? bikeAfterSale.body?.bike?.status) === 'sold',
  `status=${bikeAfterSale.body?.status ?? bikeAfterSale.body?.bike?.status}`);

// annulation → retour en stock
const pushCancel = await req('POST', '/api/sync/push', {
  token: tSeller,
  body: {
    deviceId: 'device-e2e-A',
    operations: [{ entity: 'sales', op: 'update', id: saleId, clientTs: iso(2000), payload: { status: 'annule' } }],
  },
});
const bikeAfterCancel = await req('GET', '/api/bikes/' + sellerBikeId, { token: tSeller });
check('annulation de vente → moto de nouveau disponible',
  pushCancel.body?.results?.[0]?.status === 'ok' &&
  (bikeAfterCancel.body?.status ?? bikeAfterCancel.body?.bike?.status) === 'available',
  `status=${bikeAfterCancel.body?.status ?? bikeAfterCancel.body?.bike?.status}`);

// renumérotation en cas de collision de numéro de bon
const saleId2 = uuid();
const pushSale2 = await req('POST', '/api/sync/push', {
  token: tSeller,
  body: {
    deviceId: 'device-e2e-B',
    operations: [{
      entity: 'sales', op: 'create', id: saleId2, clientTs: iso(),
      payload: { customer_id: customerId, status: 'brouillon', sale_date: iso(), sale_number: saleRes?.saleNumber, items: [] },
    }],
  },
});
check('collision de numéro de bon → renumérotation',
  pushSale2.body?.results?.[0]?.status === 'ok' && pushSale2.body.results[0].saleNumber !== saleRes?.saleNumber,
  `${saleRes?.saleNumber} → ${pushSale2.body?.results?.[0]?.saleNumber}`);

// ---------- 9b. vente croisée refusée (le vendeur ne vend pas le stock de l'admin) ----------
const crossSale = await req('POST', '/api/sync/push', {
  token: tSeller,
  body: {
    deviceId: 'device-e2e-A',
    operations: [{
      entity: 'sales', op: 'create', id: uuid(), clientTs: iso(),
      payload: { customer_id: customerId, status: 'brouillon', sale_date: iso(), items: [{ id: uuid(), bike_id: syncBikeId, unit_price: 1, quantity: 1 }] },
    }],
  },
});
check('vente du stock d\u2019autrui refusée', crossSale.body?.results?.[0]?.status === 'error',
  `status=${crossSale.body?.results?.[0]?.status}`);

// ---------- 10. suppressions (tombstones) ----------
const delBike = await req('POST', '/api/sync/push', {
  token: tAdmin,
  body: { deviceId: 'device-e2e-A', operations: [{ entity: 'bikes', op: 'delete', id: bikeId, clientTs: iso(3000) }] },
});
check('suppression logique (tombstone)', delBike.body?.results?.[0]?.status === 'ok'
  && delBike.body.results[0].deleted === true);
const pullTomb = await req('GET', '/api/sync/pull?since=' + encodeURIComponent('1970-01-01T00:00:00.000Z'), { token: tAdmin });
const tomb = (pullTomb.body?.changes || []).find((c) => c.id === bikeId);
check('tombstone propagé au pull (op=delete)', tomb?.op === 'delete', `op=${tomb?.op}`);

// ---------- 11. rôles ----------
const delSeller = await req('DELETE', '/api/bikes/' + syncBikeId, { token: tSeller });
check('DELETE /api/bikes refusé au vendeur', delSeller.status === 403, `status=${delSeller.status}`);

// ---------- 12. exports ----------
const expJson = await req('GET', '/api/exports/bikes?format=json', { token: tAdmin });
check('export JSON bikes', expJson.status === 200 && Array.isArray(expJson.body?.rows),
  `${(expJson.body?.rows || []).length} lignes, disposition=${expJson.headers.get('content-disposition')}`);
const expCsv = await req('GET', '/api/exports/sales?format=csv', { token: tAdmin, raw: true });
check('export CSV sales', expCsv.status === 200 && expCsv.body.includes('N° bon'),
  expCsv.body.split('\n')[0].slice(0, 60));
const expBad = await req('GET', '/api/exports/inconnu', { token: tAdmin });
check('export entité inconnue → 404', expBad.status === 404, `status=${expBad.status}`);

// ---------- 13. SAUVEGARDE ----------
const backupDl = await req('GET', '/api/exports/backup', { token: tAdmin, raw: true });
let backupParsed = null;
try { backupParsed = JSON.parse(backupDl.body); } catch { /* non JSON */ }
check('GET /api/exports/backup (téléchargement)',
  backupDl.status === 200 && !!backupParsed && Array.isArray(backupParsed.bikes),
  `${(backupParsed?.bikes || []).length} motos, ${(backupParsed?.customers || []).length} clients, ${(backupParsed?.sales || []).length} ventes, disposition=${backupDl.headers.get('content-disposition')}`);

const backupUp = await req('POST', '/api/exports/backup', {
  token: tAdmin,
  body: { fileName: 'e2e-local', data: { app: 'scoot-master', version: 1, bikes: backupParsed?.bikes || [] } },
});
check('POST /api/exports/backup (téléversement)', backupUp.status === 201 && !!backupUp.body?.file,
  `fichier=${backupUp.body?.file}`);

const backupBad = await req('POST', '/api/exports/backup', { token: tAdmin, body: { nope: true } });
check('téléversement sans {data} → 400', backupBad.status === 400, `status=${backupBad.status}`);

const backupList = await req('GET', '/api/exports/backups', { token: tAdmin });
check('GET /api/exports/backups (liste admin)',
  backupList.status === 200 && Array.isArray(backupList.body?.items) &&
  backupList.body.items.some((i) => i.file === backupUp.body?.file),
  `status=${backupList.status}, body=${JSON.stringify(backupList.body).slice(0, 120)}`);

const backupListSeller = await req('GET', '/api/exports/backups', { token: tSeller });
check('liste des sauvegardes refusée au vendeur (403)', backupListSeller.status === 403, `status=${backupListSeller.status}`);

// ---------- 14. statut sync ----------
const status = await req('GET', '/api/sync/status', { token: tAdmin });
check('GET /api/sync/status', status.status === 200, JSON.stringify(status.body).slice(0, 120));

// ---------- 15. AUTH : refresh, profil auto-service, RBAC utilisateurs ----------
const noAuthUsers = await req('GET', '/api/users');
check('GET /api/users sans jeton → 401 JSON', noAuthUsers.status === 401 && !!noAuthUsers.body?.error,
  `status=${noAuthUsers.status}, body=${JSON.stringify(noAuthUsers.body)}`);
const usersSeller = await req('GET', '/api/users', { token: tSeller });
check('GET /api/users refusé au vendeur → 403', usersSeller.status === 403, `status=${usersSeller.status}`);

const usersAdmin = await req('GET', '/api/users', { token: tAdmin });
check('GET /api/users autorisé à l admin', usersAdmin.status === 200 && Array.isArray(usersAdmin.body?.users),
  `${(usersAdmin.body?.users || []).length} comptes`);
const sellerId = usersAdmin.body?.users?.find((u) => u.username === 'vendeur')?.id;
const adminId = usersAdmin.body?.users?.find((u) => u.username === 'admin')?.id;

const profileSeller = await req('PATCH', '/api/users/profile', {
  token: tSeller, body: { fullName: 'Hery Andrianja (Vendeur) — E2E' },
});
check('PATCH /api/users/profile (auto-service vendeur)', profileSeller.status === 200 && !!profileSeller.body?.user,
  `fullName=${profileSeller.body?.user?.fullName}`);

const promoteSeller = await req('PATCH', `/api/users/${sellerId}`, { token: tSeller, body: { role: 'admin' } });
check('auto-promotion refusée au vendeur → 403', promoteSeller.status === 403, `status=${promoteSeller.status}`);
const editOther = await req('PATCH', `/api/users/${adminId}`, { token: tSeller, body: { fullName: 'Piraté' } });
check('édition d un autre compte refusée au vendeur → 403', editOther.status === 403, `status=${editOther.status}`);

const roleChange = await req('PUT', `/api/users/${sellerId}`, { token: tAdmin, body: { role: 'admin' } });
check('PUT /api/users/:id changement de rôle par l admin', roleChange.status === 200 && roleChange.body?.user?.role === 'admin');
await req('PATCH', `/api/users/${sellerId}`, { token: tAdmin, body: { role: 'seller' } });

const refreshSeller = await req('POST', '/api/auth/refresh', { token: tSeller });
check('POST /api/auth/refresh renouvelle le jeton', refreshSeller.status === 200 && !!refreshSeller.body?.token
  && refreshSeller.body?.user?.username === 'vendeur');
const meRefreshed = await req('GET', '/api/auth/me', { token: refreshSeller.body?.token });
check('jeton rafraîchi utilisable sur /api/auth/me', meRefreshed.status === 200);
const refreshBad = await req('POST', '/api/auth/refresh', { token: 'abc.def.ghi' });
check('refresh avec jeton invalide → 401 JSON', refreshBad.status === 401 && !!refreshBad.body?.error);

const pushNoAuthE2E = await req('POST', '/api/sync/push', { body: { deviceId: 'd', operations: [{ entity: 'bikes', op: 'update', id: 'x', clientTs: iso() }] } });
check('PUSH sans jeton → 401 JSON', pushNoAuthE2E.status === 401 && !!pushNoAuthE2E.body?.error);
const backupNoAuthE2E = await req('POST', '/api/exports/backup', { body: { fileName: 'x', data: {} } });
check('téléversement sans jeton → 401 JSON', backupNoAuthE2E.status === 401 && !!backupNoAuthE2E.body?.error);

console.log('\n=== Résultat de la vérification de bout en bout ===');
results.forEach((r) => console.log(r));
console.log(`\nTOTAL : ${pass} réussis / ${fail} échoués (sur ${pass + fail})`);
process.exit(fail ? 1 : 0);
