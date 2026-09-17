// Configuration Metro — Scoot Master (mobile/web)
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// expo-sqlite (support web) embarque wa-sqlite sous forme de binaire WASM :
// Metro doit reconnaître l'extension `.wasm` comme un asset.
config.resolver.assetExts = [...(config.resolver.assetExts || []), 'wasm'];

// Headers requis par SharedArrayBuffer (wa-sqlite / OPFS) en développement web.
config.server.enhanceMiddleware = (middleware) => {
  return (req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    return middleware(req, res, next);
  };
};

module.exports = config;
