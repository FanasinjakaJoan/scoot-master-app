'use strict';

const { config } = require('./config');
const { initDb } = require('./db/init');
const { createApp } = require('./app');

const db = initDb({ dbPath: config.dbPath, seedOnStart: config.seedOnStart });
const app = createApp(db);

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`🏍️  Scoot Master API — http://0.0.0.0:${config.port} (base : ${config.dbPath})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nArrêt du serveur…');
    server.close(() => {
      try { db.close(); } catch { /* déjà fermé */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
