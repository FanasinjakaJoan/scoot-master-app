'use strict';

/**
 * Schéma SQLite du serveur (miroir du schéma PostgreSQL dans docs/sql/postgresql_schema.sql).
 *
 * Conventions de synchronisation offline-first :
 *  - `id`         : identifiant UUID généré par l'appareil client (permet la création hors ligne).
 *  - `created_at` / `updated_at` : horodatages ISO-8601 UTC (clés de résolution de conflits LWW).
 *  - `version`    : compteur incrémenté à chaque modification serveur.
 *  - `deleted_at` : horodatage de suppression logique (tombstone) — jamais de vraie suppression.
 *  - `device_id`  : appareil ayant effectué la dernière modification (tie-break déterministe).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'seller')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

CREATE TABLE IF NOT EXISTS bikes (
  id                 TEXT PRIMARY KEY,
  brand              TEXT NOT NULL,
  model              TEXT NOT NULL,
  year               INTEGER,
  mileage_km         INTEGER NOT NULL DEFAULT 0,
  engine_cc          INTEGER,
  color              TEXT,
  serial_number      TEXT,
  price              INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'MGA',
  mechanical_state   INTEGER NOT NULL DEFAULT 3 CHECK (mechanical_state BETWEEN 1 AND 5),
  aesthetic_state    INTEGER NOT NULL DEFAULT 3 CHECK (aesthetic_state BETWEEN 1 AND 5),
  status             TEXT NOT NULL DEFAULT 'available'
                     CHECK (status IN ('available', 'reserved', 'maintenance', 'sold')),
  description        TEXT,
  warehouse          TEXT,
  photos             TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 0,
  created_by         TEXT,
  updated_by         TEXT,
  device_id          TEXT,
  deleted_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_bikes_status   ON bikes (status);
CREATE INDEX IF NOT EXISTS idx_bikes_brand    ON bikes (brand);
CREATE INDEX IF NOT EXISTS idx_bikes_updated  ON bikes (updated_at);
CREATE INDEX IF NOT EXISTS idx_bikes_deleted  ON bikes (deleted_at);

CREATE TABLE IF NOT EXISTS customers (
  id           TEXT PRIMARY KEY,
  first_name   TEXT NOT NULL,
  last_name    TEXT NOT NULL,
  phone        TEXT NOT NULL,
  email        TEXT,
  address      TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  updated_by   TEXT,
  device_id    TEXT,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_customers_updated ON customers (updated_at);
CREATE INDEX IF NOT EXISTS idx_customers_phone   ON customers (phone);

CREATE TABLE IF NOT EXISTS sales (
  id               TEXT PRIMARY KEY,
  sale_number      TEXT NOT NULL UNIQUE,
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  total            INTEGER NOT NULL DEFAULT 0,
  discount         INTEGER NOT NULL DEFAULT 0,
  amount_paid      INTEGER NOT NULL DEFAULT 0,
  payment_method   TEXT NOT NULL DEFAULT 'cash'
                   CHECK (payment_method IN ('cash', 'card', 'transfer', 'cheque', 'credit')),
  payment_status   TEXT NOT NULL DEFAULT 'unpaid'
                   CHECK (payment_status IN ('paid', 'partial', 'unpaid')),
  status           TEXT NOT NULL DEFAULT 'brouillon'
                   CHECK (status IN ('brouillon', 'confirme', 'livre', 'annule')),
  sale_date        TEXT NOT NULL,
  notes            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT,
  updated_by       TEXT,
  device_id        TEXT,
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sales_status   ON sales (status);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales (customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_updated  ON sales (updated_at);
CREATE INDEX IF NOT EXISTS idx_sales_deleted  ON sales (deleted_at);

CREATE TABLE IF NOT EXISTS sale_items (
  id          TEXT PRIMARY KEY,
  sale_id     TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  bike_id     TEXT NOT NULL REFERENCES bikes(id),
  unit_price  INTEGER NOT NULL DEFAULT 0,
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_bike ON sale_items (bike_id);

CREATE TABLE IF NOT EXISTS sale_counters (
  year INTEGER PRIMARY KEY,
  last INTEGER NOT NULL DEFAULT 0
);
`;

module.exports = { SCHEMA };
