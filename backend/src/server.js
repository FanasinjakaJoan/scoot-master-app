'use strict';

const { config } = require('./config');
const { initDb } = require('./db/init');
const { createApp } = require('./app');
const { startBackupScheduler } = require('./services/backup');

const db = initDb({ dbPath: config.dbPath, seedOnStart: config.seedOnStart });
const app = createApp(db);

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`🏍️  Scoot Master API — http://0.0.0.0:${config.port} (base : ${config.dbPath})`);
});

// Sauvegarde planifiée vers Google Drive (active seulement si BACKUP_ENABLED=true
// et qu'un compte de service est configuré — voir .env.example).
const backupScheduler = startBackupScheduler(db);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nArrêt du serveur…');
    try { backupScheduler.stop(); } catch { /* déjà arrêté */ }
    server.close(() => {
      try { db.close(); } catch { /* déjà fermé */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
