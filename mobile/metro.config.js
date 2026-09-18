// Configuration Metro — Scoot Master (mobile + web)
const http = require('http');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// La base SQLite locale du navigateur (sql.js, voir src/data/local/db.web.ts)
// est livrée sous forme de binaire WASM : Metro doit traiter `.wasm` comme un
// asset (servi sous /assets/… à l'export comme en développement).
config.resolver.assetExts = [...(config.resolver.assetExts || []), 'wasm'];

// `sql.js` garde dans son glue Emscripten des `require('fs'|'path'|'crypto')`
// réservés à Node. Jamais exécutés dans le navigateur, ils doivent malgré tout
// se résoudre : on les remplace par un module vide.
const NODE_ONLY_MODULES = new Set(['fs', 'path', 'crypto', 'os', 'child_process']);
const EMPTY_MODULE = path.resolve(__dirname, 'metro-stubs/empty.js');
const configuredResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (ctx, moduleName, platform) => {
  if (NODE_ONLY_MODULES.has(moduleName)) {
    return { type: 'sourceFile', filePath: EMPTY_MODULE };
  }
  if (configuredResolveRequest) return configuredResolveRequest(ctx, moduleName, platform);
  return ctx.resolveRequest(ctx, moduleName, platform);
};

// Proxy /api du serveur de développement web (`expo start --web`) : l'app web
// parle à l'API sur sa propre origine (même comportement qu'en conteneur, où
// deploy/web-server.js fait le relais), donc sans CORS à configurer.
// Cible : EXPO_WEB_API_TARGET (défaut http://127.0.0.1:4000).
const API_TARGET = process.env.EXPO_WEB_API_TARGET || 'http://127.0.0.1:4000';
const configuredEnhanceMiddleware = config.server.enhanceMiddleware;

function proxyApiToBackend(req, res) {
  const target = new URL(API_TARGET);
  const proxyReq = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Backend indisponible.', detail: err.message }));
  });
  req.pipe(proxyReq);
}

config.server.enhanceMiddleware = (middleware, server) => {
  const inner = configuredEnhanceMiddleware
    ? configuredEnhanceMiddleware(middleware, server)
    : middleware;
  return (req, res, next) => {
    const urlPath = (req.url || '').split('?')[0];
    if (urlPath === '/api' || urlPath.startsWith('/api/')) return proxyApiToBackend(req, res);
    return inner(req, res, next);
  };
};

module.exports = config;
