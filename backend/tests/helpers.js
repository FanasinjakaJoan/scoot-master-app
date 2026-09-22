'use strict';

const { initDb } = require('../src/db/init');
const { createApp } = require('../src/app');

/** Monte l'API sur un port éphémère avec une base en mémoire. */
async function startTestServer({ seed = true, backupService } = {}) {
  const db = initDb({ dbPath: ':memory:', seedOnStart: seed, seedUsersOnly: seed === 'users' });
  const app = createApp(db, backupService ? { backupService } : {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    db,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function login(base, username = 'admin', password = 'admin123') {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  return { status: res.status, ...body };
}

async function api(base, token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

module.exports = { startTestServer, login, api };
