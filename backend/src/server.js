'use strict';

const { config } = require('./config');
const { initDb } = require('./db/init');
const { createApp } = require('./app');
const { createBackupScheduler } = require('./services/backup');

const db = initDb({ dbPath: config.dbPath, seedOnStart: config.seedOnStart });
const app = createApp(db);

// Sauvegarde automatique : planificateur toujours démarré, mais chaque tick
// répond « skipped » (avec la raison) tant que Firebase n'est pas configuré —
// aucune erreur au démarrage, aucun impact sur l'API.
const backupScheduler = createBackupScheduler({ service: app.locals.backupService });
backupScheduler.start();

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`🏍️  Scoot Master API — http://0.0.0.0:${config.port} (base : ${config.dbPath})`);
  const b = config.firebaseBackup;
  console.log(
    b.ready
      ? `☁️  Sauvegarde Firebase active — bucket ${b.bucket}, toutes les ${b.intervalHours} h`
      : '☁️  Sauvegarde Firebase inactive (voir FIREBASE_BACKUP_ENABLED et le README).'
  );
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nArrêt du serveur…');
    backupScheduler.stop();
    server.close(() => {
      try { db.close(); } catch { /* déjà fermé */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
