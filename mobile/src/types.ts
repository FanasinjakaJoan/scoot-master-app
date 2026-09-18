/**
 * Types partagés de Scoot Master (mobile).
 * Les formes correspondent au schéma serveur (docs/DATABASE_SCHEMA.md).
 */

export type BikeStatus = 'available' | 'reserved' | 'maintenance' | 'sold';
export type SaleStatus = 'brouillon' | 'confirme' | 'livre' | 'annule';
export type PaymentMethod = 'cash' | 'card' | 'transfer' | 'cheque' | 'credit';
export type PaymentStatus = 'paid' | 'partial' | 'unpaid';
export type Role = 'admin' | 'seller';

export interface User {
  id: string;
  username: string;
  fullName: string;
  role: Role;
}

export interface Bike {
  id: string;
  brand: string;
  model: string;
  year: number | null;
  mileage_km: number;
  engine_cc: number | null;
  color: string | null;
  serial_number: string | null;
  price: number;
  currency: string;
  mechanical_state: number; // 1..5
  aesthetic_state: number; // 1..5
  status: BikeStatus;
  description: string | null;
  warehouse: string | null;
  photos: string[];
  created_at: string;
  updated_at: string;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  device_id: string | null;
  deleted_at: string | null;
}

export interface Customer {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  address: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  device_id: string | null;
  deleted_at: string | null;
}

export interface SaleItem {
  id: string;
  sale_id: string;
  bike_id: string;
  unit_price: number;
  quantity: number;
}

export interface Sale {
  id: string;
  sale_number: string;
  customer_id: string;
  total: number;
  discount: number;
  amount_paid: number;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  status: SaleStatus;
  sale_date: string; // AAAA-MM-JJ
  notes: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  device_id: string | null;
  deleted_at: string | null;
  items?: SaleItem[];
  customer?: Pick<Customer, 'id' | 'first_name' | 'last_name' | 'phone'> | null;
}

/** Opération de la file de synchronisation locale (→ POST /api/sync/push). */
export interface QueueOperation {
  id: number;
  entity: 'bikes' | 'customers' | 'sales';
  op: 'create' | 'update' | 'delete';
  entity_id: string;
  payload: Record<string, unknown>;
  client_ts: string;
  force: boolean;
  status: 'pending' | 'conflict' | 'failed';
  attempts: number;
  last_error: string | null;
}

/** Changement renvoyé par GET /api/sync/pull. */
export interface ServerChange {
  entity: 'bikes' | 'customers' | 'sales';
  id: string;
  op: 'upsert' | 'delete';
  updatedAt: string;
  version: number;
  data: Record<string, unknown>;
}

export interface ConflictRecord {
  queue_id: number;
  entity: 'bikes' | 'customers' | 'sales';
  id: string;
  server_data: Record<string, unknown>;
  detected_at: string;
}

export interface SyncStatus {
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  /** true : 401/403 en vigueur — réauthentification requise (file locale conservée). */
  authRequired: boolean;
  pendingCount: number;
  conflictCount: number;
  failedCount: number;
}

export const BIKE_STATUSES: { value: BikeStatus; label: string }[] = [
  { value: 'available', label: 'Disponible' },
  { value: 'reserved', label: 'Réservée' },
  { value: 'maintenance', label: 'En maintenance' },
  { value: 'sold', label: 'Vendue' },
];

export const SALE_STATUSES: { value: SaleStatus; label: string }[] = [
  { value: 'brouillon', label: 'Brouillon' },
  { value: 'confirme', label: 'Confirmée' },
  { value: 'livre', label: 'Livrée' },
  { value: 'annule', label: 'Annulée' },
];

export const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Espèces' },
  { value: 'card', label: 'Carte' },
  { value: 'transfer', label: 'Virement' },
  { value: 'cheque', label: 'Chèque' },
  { value: 'credit', label: 'Crédit (à terme)' },
];

export const STATE_LABELS = ['', 'Mauvais', 'Correct', 'Bon', 'Très bon', 'Excellent'];
