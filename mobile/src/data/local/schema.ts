/**
 * Schéma SQLite local + utilitaires partagés (natif **et** web).
 *
 * Séparé de `db.ts` / `db.web.ts` afin que les deux implémentations
 * d'accès à la base (expo-sqlite en natif, sql.js dans le navigateur)
 * créent exactement la même structure.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS bikes (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER,
  mileage_km INTEGER NOT NULL DEFAULT 0,
  engine_cc INTEGER,
  color TEXT,
  serial_number TEXT,
  price INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'MGA',
  mechanical_state INTEGER NOT NULL DEFAULT 3,
  aesthetic_state INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'available',
  description TEXT,
  warehouse TEXT,
  photos TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  updated_by TEXT,
  device_id TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_l_bikes_status ON bikes (status);
CREATE INDEX IF NOT EXISTS idx_l_bikes_updated ON bikes (updated_at);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  address TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  updated_by TEXT,
  device_id TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_l_customers_updated ON customers (updated_at);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  sale_number TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  status TEXT NOT NULL DEFAULT 'brouillon',
  sale_date TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  updated_by TEXT,
  device_id TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_l_sales_status ON sales (status);
CREATE INDEX IF NOT EXISTS idx_l_sales_customer ON sales (customer_id);
CREATE INDEX IF NOT EXISTS idx_l_sales_updated ON sales (updated_at);

CREATE TABLE IF NOT EXISTS sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL,
  bike_id TEXT NOT NULL,
  unit_price INTEGER NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_l_items_sale ON sale_items (sale_id);

-- ---- Tables de synchronisation (locales uniquement) ----

CREATE TABLE IF NOT EXISTS sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  op TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  client_ts TEXT NOT NULL,
  force INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_l_queue_status ON sync_queue (status, id);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  queue_id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  server_data TEXT NOT NULL,
  detected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Horodatage local ISO-8601 UTC (clé LWW côté client). */
export const nowIso = () => new Date().toISOString();
