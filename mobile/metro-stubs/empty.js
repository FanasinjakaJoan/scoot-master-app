/**
 * Module vide — repli Metro pour les modules Node uniquement référencés dans
 * la branche `if (ENVIRONMENT_IS_NODE)` de `sql.js` (`fs`, `path`, `crypto`).
 * Jamais utilisés dans le navigateur ni en React Native ; sans ce repli, la
 * résolution du bundle web échoue.
 */
module.exports = {};
