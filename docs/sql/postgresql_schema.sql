-- ============================================================================
-- Scoot Master — Schéma PostgreSQL (déploiement cloud / production)
-- Miroir exact du schéma SQLite de la démo (backend/src/db/schema.js) :
-- mêmes colonnes, mêmes conventions de synchronisation (UUID client,
-- horodatages ISO UTC, version, tombstones, device_id).
--
-- Exécution :  psql "$DATABASE_URL" -f postgresql_schema.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Utilisateurs (serveur uniquement)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'seller')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Motos du catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bikes (
  id                 UUID PRIMARY KEY,
  brand              TEXT NOT NULL,
  model              TEXT NOT NULL,
  year               INTEGER,
  mileage_km         INTEGER NOT NULL DEFAULT 0 CHECK (mileage_km >= 0),
  engine_cc          INTEGER,
  color              TEXT,
  serial_number      TEXT,
  price              BIGINT NOT NULL DEFAULT 0 CHECK (price >= 0),
  currency           TEXT NOT NULL DEFAULT 'MGA',
  mechanical_state   INTEGER NOT NULL DEFAULT 3 CHECK (mechanical_state BETWEEN 1 AND 5),
  aesthetic_state    INTEGER NOT NULL DEFAULT 3 CHECK (aesthetic_state BETWEEN 1 AND 5),
  status             TEXT NOT NULL DEFAULT 'available'
                     CHECK (status IN ('available', 'reserved', 'maintenance', 'sold')),
  description        TEXT,
  warehouse          TEXT,
  photos             JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL,
  version            INTEGER NOT NULL DEFAULT 0,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id          TEXT,
  deleted_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bikes_status  ON bikes (status)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bikes_brand   ON bikes (brand)         WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bikes_updated ON bikes (updated_at);
CREATE INDEX IF NOT EXISTS idx_bikes_search  ON bikes USING gin (to_tsvector('simple', coalesce(brand,'') || ' ' || coalesce(model,'') || ' ' || coalesce(serial_number,'') || ' ' || coalesce(description,'')));

-- ---------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id          UUID PRIMARY KEY,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  phone       TEXT NOT NULL,
  email       TEXT,
  address     TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  version     INTEGER NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id   TEXT,
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_customers_updated ON customers (updated_at);
CREATE INDEX IF NOT EXISTS idx_customers_phone   ON customers (phone) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Ventes / bons de commande
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
  id              UUID PRIMARY KEY,
  sale_number     TEXT NOT NULL UNIQUE,
  customer_id     UUID NOT NULL REFERENCES customers(id),
  total           BIGINT NOT NULL DEFAULT 0,
  discount        BIGINT NOT NULL DEFAULT 0,
  amount_paid     BIGINT NOT NULL DEFAULT 0,
  payment_method  TEXT NOT NULL DEFAULT 'cash'
                  CHECK (payment_method IN ('cash', 'card', 'transfer', 'cheque', 'credit')),
  payment_status  TEXT NOT NULL DEFAULT 'unpaid'
                  CHECK (payment_status IN ('paid', 'partial', 'unpaid')),
  status          TEXT NOT NULL DEFAULT 'brouillon'
                  CHECK (status IN ('brouillon', 'confirme', 'livre', 'annule')),
  sale_date       DATE NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  version         INTEGER NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id       TEXT,
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sales_status    ON sales (status)       WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_customer  ON sales (customer_id)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_updated   ON sales (updated_at);
CREATE INDEX IF NOT EXISTS idx_sales_date      ON sales (sale_date)    WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Lignes de vente (prix verrouillé à la vente)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_items (
  id          UUID PRIMARY KEY,
  sale_id     UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  bike_id     UUID NOT NULL REFERENCES bikes(id),
  unit_price  BIGINT NOT NULL DEFAULT 0,
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_bike ON sale_items (bike_id);

-- ---------------------------------------------------------------------------
-- Compteur annuel de numérotation des bons (BC-AAAA-NNNN)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_counters (
  year INTEGER PRIMARY KEY,
  last INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Trigger : bump de version + updated_at (usage API directe ; les opérations
-- de sync push passent par le moteur applicatif qui gère lui-même ces champs)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bump_version() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := COALESCE(OLD.version, 0) + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bikes','customers','sales'] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%s_bump ON %I;
       CREATE TRIGGER trg_%s_bump BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION bump_version();', t, t, t, t);
  END LOOP;
END;
$$;

COMMIT;
