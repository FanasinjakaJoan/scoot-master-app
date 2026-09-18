/**
 * Déclarations ambiantes pour les assets non JS importés par Metro.
 *
 * Sur le cible web, Metro résout un asset (ici le `.wasm` de sql.js) en
 * son URL d'asset (`/assets/…/fichier.<hash>.wasm`) : le module exporte donc
 * une chaîne. Sur les cibles natives, `require` renvoie `{ uri }` — l'adaptatif
 * `db.web.ts` accepte les deux formes.
 */
declare module '*.wasm' {
  const uri: string | { uri: string };
  export default uri;
}
