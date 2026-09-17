import { localDb, nowIso } from './db';
import type { SQLiteBindValue } from 'expo-sqlite';
import type { Bike, Customer, Sale, SaleItem, QueueOperation, ConflictRecord } from '../../types';

/**
 * Repositories locaux : SEUL moyen d'écrire la base locale.
 * Chaque mutation = écriture locale + opération dans sync_queue (même transaction),
 * ce qui garantit la cohérence offline-first : rien n'est perdu sans connexion.
 */

type Row = Record<string, unknown>;

/** Normalise une valeur JS vers un bind SQLite valide. */
const bind = (v: unknown): SQLiteBindValue =>
  v === undefined || v === null
    ? null
    : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
      ? v
      : v instanceof Uint8Array
        ? v
        : JSON.stringify(v);

const parsePhotos = (v: unknown): string[] => {
  if (Array.isArray(v)) return v as string[];
  try {
    const p = JSON.parse(String(v ?? '[]'));
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
};

const mapBike = (r: Row): Bike => ({
  ...(r as object),
  photos: parsePhotos(r.photos),
} as Bike);

const mapCustomer = (r: Row): Customer => r as unknown as Customer;

const mapSale = (r: Row): Sale => ({ ...(r as object) } as Sale);

const saleItems = (saleId: string): SaleItem[] =>
  localDb
    .getAllSync<SaleItem>('SELECT * FROM sale_items WHERE sale_id = ?', saleId) as SaleItem[];

// =====================================================================
// File de synchronisation
// =====================================================================

function enqueue(entity: 'bikes' | 'customers' | 'sales', op: 'create' | 'update' | 'delete', entityId: string, payload: unknown, clientTs: string, force = false): void {
  localDb.runSync(
    `INSERT INTO sync_queue (entity, op, entity_id, payload, client_ts, force, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    entity, op, entityId, JSON.stringify(payload), clientTs, force ? 1 : 0, nowIso()
  );
}

export function pendingOperations(limit = 500, statuses: QueueOperation['status'][] = ['pending', 'conflict', 'failed']): QueueOperation[] {
  const inList = statuses.map((x) => `'${x}'`).join(', ');
  return localDb
    .getAllSync<Row>(
      `SELECT * FROM sync_queue WHERE status IN (${inList}) ORDER BY id ASC LIMIT ?`,
      limit
    )
    .map((r) => ({
      id: Number(r.id),
      entity: r.entity as QueueOperation['entity'],
      op: r.op as QueueOperation['op'],
      entity_id: String(r.entity_id),
      payload: JSON.parse(String(r.payload)),
      client_ts: String(r.client_ts),
      force: Number(r.force) === 1,
      status: r.status as QueueOperation['status'],
      attempts: Number(r.attempts),
      last_error: (r.last_error as string) ?? null,
    }));
}

export function queueStats(): { pending: number; conflict: number; failed: number } {
  const r = localDb
    .getFirstSync<Row>(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'conflict' THEN 1 ELSE 0 END) AS conflict,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM sync_queue`
    );
  return {
    pending: Number(r?.pending ?? 0),
    conflict: Number(r?.conflict ?? 0),
    failed: Number(r?.failed ?? 0),
  };
}

export function markQueueOperation(id: number, patch: { status?: QueueOperation['status']; attempts?: number; lastError?: string | null; force?: boolean }): void {
  const sets: string[] = [];
  const args: SQLiteBindValue[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); args.push(patch.status); }
  if (patch.attempts !== undefined) { sets.push('attempts = ?'); args.push(patch.attempts); }
  if (patch.lastError !== undefined) { sets.push('last_error = ?'); args.push(patch.lastError); }
  if (patch.force !== undefined) { sets.push('force = ?'); args.push(patch.force ? 1 : 0); }
  if (sets.length) {
    args.push(id);
    localDb.runSync(`UPDATE sync_queue SET ${sets.join(', ')} WHERE id = ?`, ...args);
  }
}

export function removeQueueOperation(id: number): void {
  localDb.runSync('DELETE FROM sync_conflicts WHERE queue_id = ?', id);
  localDb.runSync('DELETE FROM sync_queue WHERE id = ?', id);
}

export function queueOperationById(id: number): QueueOperation | null {
  const r = localDb.getFirstSync<Row>('SELECT * FROM sync_queue WHERE id = ?', id);
  if (!r) return null;
  return {
    id: Number(r.id),
    entity: r.entity as QueueOperation['entity'],
    op: r.op as QueueOperation['op'],
    entity_id: String(r.entity_id),
    payload: JSON.parse(String(r.payload)),
    client_ts: String(r.client_ts),
    force: Number(r.force) === 1,
    status: r.status as QueueOperation['status'],
    attempts: Number(r.attempts),
    last_error: (r.last_error as string) ?? null,
  };
}

// =====================================================================
// Conflits
// =====================================================================

export function upsertConflict(queueId: number, entity: string, entityId: string, serverData: unknown): void {
  localDb.runSync(
    `INSERT INTO sync_conflicts (queue_id, entity, entity_id, server_data, detected_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(queue_id) DO UPDATE SET server_data = excluded.server_data, detected_at = excluded.detected_at`,
    queueId, entity, entityId, JSON.stringify(serverData), nowIso()
  );
}

export function listConflicts(): ConflictRecord[] {
  return localDb
    .getAllSync<Row>('SELECT * FROM sync_conflicts ORDER BY detected_at DESC')
    .map((r) => ({
      queue_id: Number(r.queue_id),
      entity: r.entity as ConflictRecord['entity'],
      id: String(r.entity_id),
      server_data: JSON.parse(String(r.server_data)),
      detected_at: String(r.detected_at),
    }));
}

export function removeConflict(queueId: number): void {
  localDb.runSync('DELETE FROM sync_conflicts WHERE queue_id = ?', queueId);
}

// =====================================================================
// Méta de synchronisation
// =====================================================================

export function metaGet(key: string): string | null {
  return localDb.getFirstSync<Row>('SELECT value FROM sync_meta WHERE key = ?', key)?.value as string | null;
}

export function metaSet(key: string, value: string): void {
  localDb.runSync(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key, value
  );
}

/** Numérotation locale des bons de commande (ré-affectée par le serveur en cas de collision). */
export function nextLocalSaleNumber(): string {
  const year = new Date().getFullYear();
  const key = 'sale_counter_' + year;
  const last = Number(metaGet(key) || 0) + 1;
  metaSet(key, String(last));
  return `BC-${year}-${String(last).padStart(4, '0')}`;
}

// =====================================================================
// Motos
// =====================================================================

const BIKE_COLS = ['brand', 'model', 'year', 'mileage_km', 'engine_cc', 'color', 'serial_number', 'price', 'currency', 'mechanical_state', 'aesthetic_state', 'status', 'description', 'warehouse', 'photos'] as const;

export function bikeById(id: string): Bike | null {
  const r = localDb.getFirstSync<Row>('SELECT * FROM bikes WHERE id = ?', id);
  return r ? mapBike(r) : null;
}

export function bikeByIdAnyState(id: string): Row | null {
  return localDb.getFirstSync<Row>('SELECT * FROM bikes WHERE id = ?', id) ?? null;
}

export function listBikes(filter: {
  status?: string; brand?: string; q?: string; minPrice?: number; maxPrice?: number;
  sort?: 'updated_at' | 'price' | 'mileage_km' | 'brand'; order?: 'asc' | 'desc'; limit?: number;
} = {}): Bike[] {
  const where: string[] = ['deleted_at IS NULL'];
  const args: SQLiteBindValue[] = [];
  if (filter.status) { where.push('status = ?'); args.push(filter.status); }
  if (filter.brand) { where.push('brand = ?'); args.push(filter.brand); }
  if (filter.q) {
    where.push('(brand LIKE ? OR model LIKE ? OR serial_number LIKE ? OR description LIKE ?)');
    const like = `%${filter.q}%`;
    args.push(like, like, like, like);
  }
  if (filter.minPrice !== undefined) { where.push('price >= ?'); args.push(filter.minPrice); }
  if (filter.maxPrice !== undefined) { where.push('price <= ?'); args.push(filter.maxPrice); }
  const sortCol = filter.sort === 'price' ? 'price' : filter.sort === 'mileage_km' ? 'mileage_km' : filter.sort === 'brand' ? 'brand' : 'updated_at';
  const dir = filter.order === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(filter.limit ?? 200, 500);
  return localDb
    .getAllSync<Row>(`SELECT * FROM bikes WHERE ${where.join(' AND ')} ORDER BY ${sortCol} ${dir}, id ${dir} LIMIT ?`, ...args, limit)
    .map(mapBike);
}

export function availableBrands(): string[] {
  return localDb
    .getAllSync<Row>('SELECT DISTINCT brand FROM bikes WHERE deleted_at IS NULL ORDER BY brand')
    .map((r) => String(r.brand));
}

/** Écriture locale complète d'une moto + enfilement de la synchro. */
export function saveBike(input: Partial<Bike> & { id: string }, actor: { userId: string; deviceId: string }): 'create' | 'update' {
  const ts = nowIso();
  const existing = bikeByIdAnyState(input.id);
  const op = existing ? 'update' : 'create';
  const b = input as Bike;
  localDb.withTransactionSync(() => {
    if (!existing) {
      localDb.runSync(
        `INSERT INTO bikes (id, brand, model, year, mileage_km, engine_cc, color, serial_number, price, currency,
           mechanical_state, aesthetic_state, status, description, warehouse, photos,
           created_at, updated_at, version, created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        b.id, b.brand, b.model ?? null, b.year ?? null, b.mileage_km ?? 0, b.engine_cc ?? null,
        b.color ?? null, b.serial_number ?? null, b.price ?? 0, b.currency || 'MGA',
        b.mechanical_state ?? 3, b.aesthetic_state ?? 3, b.status || 'available',
        b.description ?? null, b.warehouse ?? null, JSON.stringify(b.photos || []),
        ts, ts, actor.userId, actor.userId, actor.deviceId
      );
    } else {
      localDb.runSync(
        `UPDATE bikes SET brand = ?, model = ?, year = ?, mileage_km = ?, engine_cc = ?, color = ?,
           serial_number = ?, price = ?, currency = ?, mechanical_state = ?, aesthetic_state = ?,
           status = ?, description = ?, warehouse = ?, photos = ?, deleted_at = NULL,
           updated_at = ?, updated_by = ?, device_id = ?, version = version + 1
         WHERE id = ?`,
        b.brand, b.model ?? null, b.year ?? null, b.mileage_km ?? 0, b.engine_cc ?? null,
        b.color ?? null, b.serial_number ?? null, b.price ?? 0, b.currency || 'MGA',
        b.mechanical_state ?? 3, b.aesthetic_state ?? 3, b.status || 'available',
        b.description ?? null, b.warehouse ?? null, JSON.stringify(b.photos || []),
        ts, actor.userId, actor.deviceId, b.id
      );
    }
    const row = bikeByIdAnyState(b.id);
    if (row) {
      const payload: Record<string, unknown> = {};
      for (const c of BIKE_COLS) payload[c] = row[c];
      payload.photos = parsePhotos(row.photos);
      enqueue('bikes', op, b.id, payload, ts);
    }
  });
  return op;
}

/** Mise à jour partielle locale (ex. effet de domaine : moto → vendue). */
export function patchBike(id: string, patch: Partial<Bike>, actor: { userId: string; deviceId: string }): void {
  const current = bikeByIdAnyState(id);
  if (!current) return;
  const ts = nowIso();
  localDb.withTransactionSync(() => {
    localDb.runSync(
      `UPDATE bikes SET brand = ?, model = ?, year = ?, mileage_km = ?, engine_cc = ?, color = ?,
         serial_number = ?, price = ?, currency = ?, mechanical_state = ?, aesthetic_state = ?,
         status = ?, description = ?, warehouse = ?, photos = ?,
         updated_at = ?, updated_by = ?, device_id = ?, version = version + 1
       WHERE id = ?`,
      bind(patch.brand ?? current.brand), bind(patch.model ?? current.model),
      bind(patch.year !== undefined ? patch.year : current.year),
      patch.mileage_km ?? Number(current.mileage_km),
      bind(patch.engine_cc !== undefined ? patch.engine_cc : current.engine_cc),
      bind(patch.color !== undefined ? patch.color : current.color),
      bind(patch.serial_number !== undefined ? patch.serial_number : current.serial_number),
      patch.price ?? Number(current.price), bind(patch.currency || current.currency),
      patch.mechanical_state ?? Number(current.mechanical_state), patch.aesthetic_state ?? Number(current.aesthetic_state),
      bind(patch.status ?? current.status),
      bind(patch.description !== undefined ? patch.description : current.description),
      bind(patch.warehouse !== undefined ? patch.warehouse : current.warehouse), bind(current.photos),
      ts, actor.userId, actor.deviceId, id
    );
    const row = bikeByIdAnyState(id);
    if (row) {
      const payload: Record<string, unknown> = {};
      for (const c of BIKE_COLS) payload[c] = row[c];
      payload.photos = parsePhotos(row.photos);
      enqueue('bikes', 'update', id, payload, ts);
    }
  });
}

export function deleteBike(id: string, actor: { userId: string; deviceId: string }): void {
  const ts = nowIso();
  localDb.withTransactionSync(() => {
    localDb.runSync('UPDATE bikes SET deleted_at = ?, updated_at = ?, updated_by = ?, device_id = ?, version = version + 1 WHERE id = ?', ts, ts, actor.userId, actor.deviceId, id);
    enqueue('bikes', 'delete', id, { id }, ts);
  });
}

// =====================================================================
// Clients
// =====================================================================

export function customerById(id: string): Customer | null {
  const r = localDb.getFirstSync<Row>('SELECT * FROM customers WHERE id = ?', id);
  return r ? mapCustomer(r) : null;
}

export function listCustomers(q?: string, limit = 200): Customer[] {
  const where = ['deleted_at IS NULL'];
  const args: SQLiteBindValue[] = [];
  if (q) {
    where.push('(first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR email LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  return localDb
    .getAllSync<Row>(`SELECT * FROM customers WHERE ${where.join(' AND ')} ORDER BY last_name, first_name LIMIT ?`, ...args, limit)
    .map(mapCustomer);
}

export function customerSalesStats(id: string): { nbSales: number; totalSpent: number } {
  const r = localDb
    .getFirstSync<Row>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS t FROM sales WHERE customer_id = ? AND deleted_at IS NULL`,
      id
    );
  return { nbSales: Number(r?.n ?? 0), totalSpent: Number(r?.t ?? 0) };
}

const CUSTOMER_COLS = ['first_name', 'last_name', 'phone', 'email', 'address', 'notes'] as const;

export function saveCustomer(input: Partial<Customer> & { id: string }, actor: { userId: string; deviceId: string }): 'create' | 'update' {
  const ts = nowIso();
  const existing = localDb.getFirstSync<Row>('SELECT * FROM customers WHERE id = ?', input.id);
  const op = existing ? 'update' : 'create';
  const c = input as Customer;
  localDb.withTransactionSync(() => {
    if (!existing) {
      localDb.runSync(
        `INSERT INTO customers (id, first_name, last_name, phone, email, address, notes,
           created_at, updated_at, version, created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        c.id, c.first_name, c.last_name, c.phone, c.email ?? null, c.address ?? null, c.notes ?? null,
        ts, ts, actor.userId, actor.userId, actor.deviceId
      );
    } else {
      localDb.runSync(
        `UPDATE customers SET first_name = ?, last_name = ?, phone = ?, email = ?, address = ?, notes = ?,
           deleted_at = NULL, updated_at = ?, updated_by = ?, device_id = ?, version = version + 1
         WHERE id = ?`,
        c.first_name, c.last_name, c.phone, c.email ?? null, c.address ?? null, c.notes ?? null,
        ts, actor.userId, actor.deviceId, c.id
      );
    }
    const row = localDb.getFirstSync<Row>('SELECT * FROM customers WHERE id = ?', c.id);
    if (row) {
      const payload: Record<string, unknown> = {};
      for (const k of CUSTOMER_COLS) payload[k] = row[k];
      enqueue('customers', op, c.id, payload, ts);
    }
  });
  return op;
}

export function deleteCustomer(id: string, actor: { userId: string; deviceId: string }): void {
  const ts = nowIso();
  localDb.withTransactionSync(() => {
    localDb.runSync('UPDATE customers SET deleted_at = ?, updated_at = ?, updated_by = ?, device_id = ?, version = version + 1 WHERE id = ?', ts, ts, actor.userId, actor.deviceId, id);
    enqueue('customers', 'delete', id, { id }, ts);
  });
}

// =====================================================================
// Ventes (bons de commande)
// =====================================================================

const SALE_COLS = ['sale_number', 'customer_id', 'total', 'discount', 'amount_paid', 'payment_method', 'payment_status', 'status', 'sale_date', 'notes'] as const;

export function saleById(id: string): Sale | null {
  const r = localDb.getFirstSync<Row>('SELECT * FROM sales WHERE id = ?', id);
  if (!r) return null;
  const s = mapSale(r);
  s.items = saleItems(id);
  const cust = localDb.getFirstSync<Row>('SELECT id, first_name, last_name, phone FROM customers WHERE id = ?', s.customer_id);
  s.customer = cust ? { id: String(cust.id), first_name: String(cust.first_name), last_name: String(cust.last_name), phone: String(cust.phone) } : null;
  return s;
}

export function listSales(filter: { status?: string; customerId?: string; from?: string; to?: string; limit?: number } = {}): Sale[] {
  const where: string[] = ['s.deleted_at IS NULL'];
  const args: SQLiteBindValue[] = [];
  if (filter.status) { where.push('s.status = ?'); args.push(filter.status); }
  if (filter.customerId) { where.push('s.customer_id = ?'); args.push(filter.customerId); }
  if (filter.from) { where.push('s.sale_date >= ?'); args.push(filter.from); }
  if (filter.to) { where.push('s.sale_date <= ?'); args.push(filter.to); }
  const limit = Math.min(filter.limit ?? 200, 500);
  return localDb
    .getAllSync<Row>(
      `SELECT s.*, c.first_name AS c_first, c.last_name AS c_last, c.phone AS c_phone
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
       WHERE ${where.join(' AND ')} ORDER BY s.sale_date DESC, s.updated_at DESC LIMIT ?`,
      ...args, limit
    )
    .map((r) => {
      const s = mapSale(r);
      s.items = saleItems(s.id);
      s.customer = r.c_first ? { id: s.customer_id, first_name: String(r.c_first), last_name: String(r.c_last), phone: String(r.c_phone) } : null;
      return s;
    });
}

export function bikesForSale(): Bike[] {
  return listBikes({ status: 'available', limit: 500 });
}

/**
 * Enregistre une vente (brouillon ou confirmée) — fonctionne 100 % hors ligne.
 * Effet de domaine local : confirmée/livrée → motos « vendues » (opérations enfilées,
 * identiques à l'effet appliqué par le serveur à la synchronisation).
 */
export function saveSale(input: {
  id: string;
  customer_id: string;
  items: { id?: string; bike_id: string; unit_price: number; quantity: number }[];
  discount?: number;
  amount_paid?: number;
  payment_method?: Sale['payment_method'];
  status?: Sale['status'];
  sale_date?: string;
  notes?: string | null;
  sale_number?: string;
}, actor: { userId: string; deviceId: string }): Sale {
  const ts = nowIso();
  const existing = localDb.getFirstSync<Row>('SELECT * FROM sales WHERE id = ?', input.id);
  const op = existing ? 'update' : 'create';
  const gross = input.items.reduce((s, it) => s + (it.unit_price || 0) * Math.max(1, it.quantity || 1), 0);
  const total = gross - (input.discount || 0);
  const paid = input.amount_paid || 0;
  const paymentStatus: Sale['payment_status'] = paid <= 0 ? 'unpaid' : paid >= total ? 'paid' : 'partial';
  const status = input.status || 'brouillon';
  const saleDate = input.sale_date || ts.slice(0, 10);

  localDb.withTransactionSync(() => {
    if (!existing) {
      localDb.runSync(
        `INSERT INTO sales (id, sale_number, customer_id, total, discount, amount_paid, payment_method,
           payment_status, status, sale_date, notes, created_at, updated_at, version, created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        input.id, input.sale_number || nextLocalSaleNumber(), input.customer_id, total,
        input.discount || 0, paid, input.payment_method || 'cash', paymentStatus, status, saleDate,
        input.notes ?? null, ts, ts, actor.userId, actor.userId, actor.deviceId
      );
    } else {
      localDb.runSync(
        `UPDATE sales SET sale_number = ?, customer_id = ?, total = ?, discount = ?, amount_paid = ?,
           payment_method = ?, payment_status = ?, status = ?, sale_date = ?, notes = ?,
           deleted_at = NULL, updated_at = ?, updated_by = ?, device_id = ?, version = version + 1
         WHERE id = ?`,
        bind(input.sale_number || existing.sale_number), input.customer_id, total, input.discount || 0, paid,
        String(input.payment_method || existing.payment_method), paymentStatus, status, saleDate, input.notes ?? null,
        ts, actor.userId, actor.deviceId, input.id
      );
    }

    localDb.runSync('DELETE FROM sale_items WHERE sale_id = ?', input.id);
    for (const it of input.items) {
      localDb.runSync(
        'INSERT INTO sale_items (id, sale_id, bike_id, unit_price, quantity) VALUES (?, ?, ?, ?, ?)',
        it.id || `si-${input.id}-${Math.random().toString(36).slice(2, 10)}`, input.id, it.bike_id, it.unit_price || 0, Math.max(1, it.quantity || 1)
      );
    }

    // Effet de domaine : état des motos
    for (const it of input.items) {
      const bike = bikeByIdAnyState(it.bike_id);
      if (!bike || bike.deleted_at) continue;
      const target = status === 'confirme' || status === 'livre' ? 'sold' : 'available';
      if (bike.status !== target) {
        localDb.runSync('UPDATE bikes SET status = ?, updated_at = ?, updated_by = ?, device_id = ?, version = version + 1 WHERE id = ?', target, ts, actor.userId, actor.deviceId, it.bike_id);
        const row = bikeByIdAnyState(it.bike_id);
        if (row) {
          const payload: Record<string, unknown> = {};
          for (const c of BIKE_COLS) payload[c] = row[c];
          payload.photos = parsePhotos(row.photos);
          enqueue('bikes', 'update', it.bike_id, payload, ts);
        }
      }
    }

    const row = localDb.getFirstSync<Row>('SELECT * FROM sales WHERE id = ?', input.id);
    if (row) {
      const payload: Record<string, unknown> = {};
      for (const c of SALE_COLS) payload[c] = row[c];
      payload.items = input.items;
      enqueue('sales', op, input.id, payload, ts);
    }
  });

  return saleById(input.id) as Sale;
}

export function patchSaleStatus(id: string, status: Sale['status'], actor: { userId: string; deviceId: string }): void {
  const s = saleById(id);
  if (!s) return;
  saveSale(
    {
      id: s.id,
      customer_id: s.customer_id,
      items: s.items || [],
      discount: s.discount,
      amount_paid: s.amount_paid,
      payment_method: s.payment_method,
      status,
      sale_date: s.sale_date,
      notes: s.notes,
      sale_number: s.sale_number,
    },
    actor
  );
}

export function deleteSale(id: string, actor: { userId: string; deviceId: string }): void {
  const s = saleById(id);
  const ts = nowIso();
  localDb.withTransactionSync(() => {
    // Effet de domaine : motos remises en stock (si libres)
    if (s) {
      for (const it of s.items || []) {
        const bike = bikeByIdAnyState(it.bike_id);
        if (!bike || bike.deleted_at) continue;
        const stillSold = localDb.getFirstSync<Row>(
          `SELECT 1 AS x FROM sale_items si JOIN sales s2 ON s2.id = si.sale_id
           WHERE si.bike_id = ? AND s2.id != ? AND s2.deleted_at IS NULL AND s2.status IN ('confirme','livre')`,
          it.bike_id, id
        );
        if (!stillSold && bike.status === 'sold') {
          localDb.runSync('UPDATE bikes SET status = ?, updated_at = ?, updated_by = ?, device_id = ?, version = version + 1 WHERE id = ?', 'available', ts, actor.userId, actor.deviceId, it.bike_id);
          const row = bikeByIdAnyState(it.bike_id);
          if (row) {
            const payload: Record<string, unknown> = {};
            for (const c of BIKE_COLS) payload[c] = row[c];
            payload.photos = parsePhotos(row.photos);
            enqueue('bikes', 'update', it.bike_id, payload, ts);
          }
        }
      }
    }
    localDb.runSync('UPDATE sales SET deleted_at = ?, updated_at = ?, updated_by = ?, device_id = ?, version = version + 1 WHERE id = ?', ts, ts, actor.userId, actor.deviceId, id);
    enqueue('sales', 'delete', id, { id }, ts);
  });
}

// =====================================================================
// Application des changements serveur (PULL) — LWW local
// =====================================================================

type EntityName = 'bikes' | 'customers' | 'sales';

function localUpdatedAt(entity: EntityName, id: string): string | null {
  return localDb.getFirstSync<Row>(`SELECT updated_at FROM ${entity} WHERE id = ?`, id)?.updated_at as string | null;
}

/**
 * Applique un changement serveur si (et seulement si) il est plus récent
 * que la copie locale (Last-Write-Wins sur updated_at ISO).
 * Retourne true si la copie locale a été mise à jour.
 */
export function applyServerChange(entity: EntityName, id: string, op: 'upsert' | 'delete', updatedAt: string, data: Record<string, unknown>): boolean {
  const localTs = localUpdatedAt(entity, id);
  if (op === 'upsert' && localTs && localTs >= updatedAt) return false;
  if (op === 'delete' && localTs && localTs > updatedAt) return false;

  localDb.withTransactionSync(() => {
    if (op === 'delete') {
      localDb.runSync(`UPDATE ${entity} SET deleted_at = ?, updated_at = ? WHERE id = ?`, updatedAt, updatedAt, id);
      if (entity === 'sales') {
        // Remise en stock locale (miroir de l'effet de domaine serveur)
        const items = localDb.getAllSync<Row>('SELECT bike_id FROM sale_items WHERE sale_id = ?', id);
        for (const it of items) {
          const bike = localDb.getFirstSync<Row>('SELECT * FROM bikes WHERE id = ?', String(it.bike_id));
          if (!bike || bike.deleted_at) continue;
          const other = localDb.getFirstSync<Row>(
            `SELECT 1 AS x FROM sale_items si JOIN sales s2 ON s2.id = si.sale_id
             WHERE si.bike_id = ? AND s2.id != ? AND s2.deleted_at IS NULL AND s2.status IN ('confirme','livre')`,
            String(it.bike_id), id
          );
          if (!other && bike.status === 'sold') {
            localDb.runSync('UPDATE bikes SET status = ?, updated_at = ? WHERE id = ?', 'available', updatedAt, String(it.bike_id));
          }
        }
      }
      return;
    }

    const d = { ...data };
    const version = Number(d.version ?? 0);
    if (entity === 'bikes') {
      const exists = localDb.getFirstSync<Row>('SELECT id FROM bikes WHERE id = ?', id);
      const photosJson = JSON.stringify(d.photos || []);
      if (!exists) {
        localDb.runSync(
          `INSERT INTO bikes (id, brand, model, year, mileage_km, engine_cc, color, serial_number, price, currency,
             mechanical_state, aesthetic_state, status, description, warehouse, photos,
             created_at, updated_at, version, created_by, updated_by, device_id, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, bind(d.brand), bind(d.model), bind(d.year), bind(d.mileage_km), bind(d.engine_cc), bind(d.color),
          bind(d.serial_number), bind(d.price), String(d.currency || 'MGA'), bind(d.mechanical_state),
          bind(d.aesthetic_state), String(bind(d.status) ?? 'available'), bind(d.description), bind(d.warehouse),
          photosJson, bind(d.created_at) || updatedAt, bind(d.updated_at) || updatedAt, version,
          bind(d.created_by), bind(d.updated_by), bind(d.device_id), bind(d.deleted_at)
        );
      } else {
        localDb.runSync(
          `UPDATE bikes SET brand = ?, model = ?, year = ?, mileage_km = ?, engine_cc = ?, color = ?,
             serial_number = ?, price = ?, currency = ?, mechanical_state = ?, aesthetic_state = ?,
             status = ?, description = ?, warehouse = ?, photos = ?,
             updated_at = ?, version = ?, updated_by = ?, device_id = ?, deleted_at = ?
           WHERE id = ?`,
          bind(d.brand), bind(d.model), bind(d.year), bind(d.mileage_km), bind(d.engine_cc), bind(d.color),
          bind(d.serial_number), bind(d.price), String(d.currency || 'MGA'), bind(d.mechanical_state),
          bind(d.aesthetic_state), String(bind(d.status) ?? 'available'), bind(d.description), bind(d.warehouse),
          photosJson, bind(d.updated_at) || updatedAt, version, bind(d.updated_by), bind(d.device_id),
          bind(d.deleted_at), id
        );
      }
    } else if (entity === 'customers') {
      const exists = localDb.getFirstSync<Row>('SELECT id FROM customers WHERE id = ?', id);
      if (!exists) {
        localDb.runSync(
          `INSERT INTO customers (id, first_name, last_name, phone, email, address, notes,
             created_at, updated_at, version, created_by, updated_by, device_id, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, bind(d.first_name), bind(d.last_name), bind(d.phone), bind(d.email), bind(d.address), bind(d.notes),
          bind(d.created_at) || updatedAt, bind(d.updated_at) || updatedAt, version,
          bind(d.created_by), bind(d.updated_by), bind(d.device_id), bind(d.deleted_at)
        );
      } else {
        localDb.runSync(
          `UPDATE customers SET first_name = ?, last_name = ?, phone = ?, email = ?, address = ?, notes = ?,
             updated_at = ?, version = ?, updated_by = ?, device_id = ?, deleted_at = ?
           WHERE id = ?`,
          bind(d.first_name), bind(d.last_name), bind(d.phone), bind(d.email), bind(d.address), bind(d.notes),
          bind(d.updated_at) || updatedAt, version, bind(d.updated_by), bind(d.device_id),
          bind(d.deleted_at), id
        );
      }
    } else {
      // sales
      const exists = localDb.getFirstSync<Row>('SELECT id FROM sales WHERE id = ?', id);
      if (!exists) {
        localDb.runSync(
          `INSERT INTO sales (id, sale_number, customer_id, total, discount, amount_paid, payment_method,
             payment_status, status, sale_date, notes, created_at, updated_at, version, created_by, updated_by, device_id, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, bind(d.sale_number), bind(d.customer_id), bind(d.total), bind(d.discount), bind(d.amount_paid),
          String(d.payment_method || 'cash'), String(d.payment_status || 'unpaid'), String(d.status || 'brouillon'),
          bind(d.sale_date) || updatedAt.slice(0, 10), bind(d.notes), bind(d.created_at) || updatedAt,
          bind(d.updated_at) || updatedAt, version, bind(d.created_by), bind(d.updated_by),
          bind(d.device_id), bind(d.deleted_at)
        );
      } else {
        localDb.runSync(
          `UPDATE sales SET sale_number = ?, customer_id = ?, total = ?, discount = ?, amount_paid = ?,
             payment_method = ?, payment_status = ?, status = ?, sale_date = ?, notes = ?,
             updated_at = ?, version = ?, updated_by = ?, device_id = ?, deleted_at = ?
           WHERE id = ?`,
          bind(d.sale_number), bind(d.customer_id), bind(d.total), bind(d.discount), bind(d.amount_paid),
          String(d.payment_method || 'cash'), String(d.payment_status || 'unpaid'), String(d.status || 'brouillon'),
          bind(d.sale_date) || updatedAt.slice(0, 10), bind(d.notes),
          bind(d.updated_at) || updatedAt, version, bind(d.updated_by), bind(d.device_id),
          bind(d.deleted_at), id
        );
      }
      if (Array.isArray(d.items)) {
        localDb.runSync('DELETE FROM sale_items WHERE sale_id = ?', id);
        for (const it of d.items as SaleItem[]) {
          localDb.runSync(
            'INSERT INTO sale_items (id, sale_id, bike_id, unit_price, quantity) VALUES (?, ?, ?, ?, ?)',
            it.id, id, it.bike_id, it.unit_price ?? 0, it.quantity ?? 1
          );
        }
      }
      // Effet de domaine : état des motos (miroir serveur)
      const status = String(d.status || 'brouillon');
      const items = (Array.isArray(d.items) ? d.items : localDb.getAllSync<Row>('SELECT bike_id FROM sale_items WHERE sale_id = ?', id)) as { bike_id: string }[];
      for (const it of items) {
        const bike = localDb.getFirstSync<Row>('SELECT * FROM bikes WHERE id = ?', it.bike_id);
        if (!bike || bike.deleted_at) continue;
        const target = status === 'confirme' || status === 'livre' ? 'sold' : 'available';
        if (bike.status !== target) {
          const other = localDb.getFirstSync<Row>(
            `SELECT 1 AS x FROM sale_items si JOIN sales s2 ON s2.id = si.sale_id
             WHERE si.bike_id = ? AND s2.id != ? AND s2.deleted_at IS NULL AND s2.status IN ('confirme','livre')`,
            it.bike_id, id
          );
          const canFree = !(status === 'confirme' || status === 'livre') && !other;
          if ((status === 'confirme' || status === 'livre') || canFree) {
            localDb.runSync('UPDATE bikes SET status = ?, updated_at = ? WHERE id = ?', target, updatedAt, it.bike_id);
          }
        }
      }
    }
  });
  return true;
}

// =====================================================================
// Export / sauvegarde locale
// =====================================================================

export function localBackup(): Record<string, unknown> {
  return {
    app: 'scoot-master',
    version: 1,
    exportedAt: nowIso(),
    bikes: localDb.getAllSync<Row>('SELECT * FROM bikes'),
    customers: localDb.getAllSync<Row>('SELECT * FROM customers'),
    sales: localDb
      .getAllSync<Row>('SELECT * FROM sales')
      .map((s) => ({ ...s, items: localDb.getAllSync<Row>('SELECT * FROM sale_items WHERE sale_id = ?', String(s.id)) })),
  };
}

// =====================================================================
// Statistiques tableau de bord
// =====================================================================

export function dashboardStats() {
  const bikes = localDb.getFirstSync<Row>(
    `SELECT
       SUM(CASE WHEN deleted_at IS NULL AND status = 'available' THEN 1 ELSE 0 END) AS available,
       SUM(CASE WHEN deleted_at IS NULL AND status = 'sold' THEN 1 ELSE 0 END) AS sold,
       COALESCE(SUM(CASE WHEN deleted_at IS NULL AND status = 'available' THEN price ELSE 0 END), 0) AS stockValue
     FROM bikes`
  );
  const monthStart = new Date().toISOString().slice(0, 8) + '01';
  const salesMonth = localDb.getFirstSync<Row>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS t FROM sales
     WHERE deleted_at IS NULL AND status IN ('confirme','livre') AND sale_date >= ?`,
    monthStart
  );
  const customers = localDb.getFirstSync<Row>('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL');
  return {
    availableBikes: Number(bikes?.available ?? 0),
    soldBikes: Number(bikes?.sold ?? 0),
    stockValue: Number(bikes?.stockValue ?? 0),
    salesThisMonth: Number(salesMonth?.n ?? 0),
    revenueThisMonth: Number(salesMonth?.t ?? 0),
    customersCount: Number(customers?.n ?? 0),
  };
}
