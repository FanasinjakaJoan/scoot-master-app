'use strict';

/**
 * Isolation des données utilisateur (Row-Level Security applicative) + RBAC.
 *
 * Règle unique, appliquée à toutes les entités métier (`bikes`, `customers`,
 * `sales`) : un utilisateur authentifié de rôle `seller` ne peut lire,
 * modifier ou supprimer QUE les lignes dont il est le propriétaire
 * (`owner_id = req.user.id`). Le rôle `admin` contourne ce filtre et voit
 * l'intégralité des données de l'application.
 *
 * Le filtre est ajouté au SQL (et non appliqué après coup en mémoire) : une
 * ligne hors périmètre est donc invisible, indistinguable d'une ligne absente
 * (404/403), et les agrégats/`COUNT` restent exacts.
 *
 * `owner_id` est renseigné à la création à partir de l'utilisateur authentifié
 * uniquement — la valeur envoyée par le client (payload de synchronisation
 * incluse) n'est jamais reprise, sinon un vendeur pourrait s'attribuer la
 * propriété d'une ligne au nom d'un autre.
 */

const ENTITIES_WITH_OWNER = ['bikes', 'customers', 'sales'];

/** Vrai si l'utilisateur a un accès global (admin). */
function isAdmin(user) {
  return Boolean(user && user.role === 'admin');
}

/**
 * Clause `owner_id = ?` à ajouter au WHERE d'une requête, avec l'argument
 * correspondant. Renvoie `null` pour un admin (aucune restriction).
 *
 * @param {import('express').Request} req requête portant `req.user`
 * @param {string} [alias] alias de table (ex. `b` pour `bikes b`)
 * @returns {{ clause: string, arg: string }|null}
 */
function ownerFilter(req, alias = '') {
  if (isAdmin(req.user)) return null;
  const col = alias ? `${alias}.owner_id` : 'owner_id';
  return { clause: `${col} = ?`, arg: req.user.id };
}

/**
 * Ajoute le filtre de propriété à un tableau de clauses WHERE/args.
 * No-op pour un admin.
 */
function appendOwnerFilter(req, where, args, alias = '') {
  const filter = ownerFilter(req, alias);
  if (!filter) return;
  where.push(filter.clause);
  args.push(filter.arg);
}

/**
 * Charge une ligne en respectant le périmètre de l'utilisateur.
 * Renvoie `null` si la ligne n'existe pas OU appartient à quelqu'un d'autre
 * (un vendeur ne doit pas pouvoir déduire l'existence d'une ligne d'autrui).
 *
 * @param {{prepare:Function}} db
 * @param {import('express').Request} req
 * @param {string} entity nom de table (liste blanche interne)
 * @param {string} id identifiant de la ligne
 * @param {string} [extraWhere] condition SQL supplémentaire (ex. `deleted_at IS NULL`)
 */
function findScoped(db, req, entity, id, extraWhere = '') {
  assertEntity(entity);
  const where = ['id = ?'];
  const args = [id];
  if (extraWhere) where.push(extraWhere);
  appendOwnerFilter(req, where, args);
  return db.prepare(`SELECT * FROM ${entity} WHERE ${where.join(' AND ')}`).get(...args) || null;
}

/** Vrai si l'utilisateur peut modifier/supprimer la ligne (propriétaire ou admin). */
function canAccessRow(req, row) {
  if (!row) return false;
  if (isAdmin(req.user)) return true;
  return row.owner_id === req.user.id;
}

/** Propriétaire à stocker lors d'une création : l'utilisateur authentifié. */
function ownerForCreate(req, payloadOwner) {
  if (isAdmin(req.user)) return payloadOwner || req.user.id;
  return req.user.id;
}

function assertEntity(entity) {
  if (!ENTITIES_WITH_OWNER.includes(entity)) {
    throw new Error('Entité non isolable : ' + entity);
  }
}

/**
 * Journalise une action sensible dans `audit_log` (best-effort : une erreur de
 * journalisation ne doit jamais faire échouer la requête métier).
 */
function audit(db, { req, action, entity, entityId, ownerId, details }) {
  try {
    const user = (req && req.user) || {};
    db.prepare(`
      INSERT INTO audit_log (at, actor_id, actor_role, action, entity, entity_id, owner_id, admin_access, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(), user.id || null, user.role || null, action,
      entity || null, entityId || null, ownerId || null, isAdmin(user) ? 1 : 0,
      details ? JSON.stringify(details) : null
    );
  } catch { /* la journalisation est optionnelle */ }
}

module.exports = {
  ENTITIES_WITH_OWNER,
  isAdmin,
  ownerFilter,
  appendOwnerFilter,
  findScoped,
  canAccessRow,
  ownerForCreate,
  audit,
};
