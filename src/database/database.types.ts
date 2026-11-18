import { type ColumnType, type Generated, type Insertable, type Selectable } from 'kysely';

type CreatedAt = ColumnType<Date, Date | undefined, never>;
type UpdatedAt = ColumnType<Date, Date | undefined, Date>;

export type ReservationStatus = 'ACTIVE' | 'PARTIALLY_RELEASED' | 'RELEASED';
export type Origin = 'API' | 'TREASURY';
export type LedgerEntryType = 'RESERVE' | 'RELEASE' | 'LIMIT_SET' | 'RECONCILE_ADJUST';

export interface ProgramsTable {
  id: string;
  currency: string;
  limit_minor: bigint;
  utilised_minor: Generated<bigint>;
  version: Generated<bigint>;
  treasury_revision: Generated<bigint>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ReservationsTable {
  id: Generated<string>;
  program_id: string;
  invoice_id: string;
  status: ReservationStatus;
  origin: Origin;
  invoice_amount_minor: bigint;
  invoice_currency: string;
  invoice_released_minor: Generated<bigint>;
  booked_minor: bigint;
  released_minor: Generated<bigint>;
  fx_rate: bigint | null;
  fx_scale: number | null;
  fx_source: string | null;
  fx_as_of: Date | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ReleasesTable {
  id: Generated<string>;
  reservation_id: string;
  release_id: string;
  requested_invoice_amount_minor: bigint | null;
  invoice_amount_minor: bigint;
  freed_minor: bigint;
  origin: Origin;
  actor: string;
  created_at: CreatedAt;
}

export interface LedgerEntriesTable {
  id: Generated<bigint>;
  type: LedgerEntryType;
  program_id: string;
  reservation_id: string | null;
  delta_minor: bigint;
  utilised_after_minor: bigint;
  limit_after_minor: bigint;
  actor: string;
  correlation_id: string | null;
  source_message_id: string | null;
  reason: string | null;
  created_at: CreatedAt;
}

export interface Database {
  programs: ProgramsTable;
  reservations: ReservationsTable;
  releases: ReleasesTable;
  ledger_entries: LedgerEntriesTable;
}

export type ProgramRow = Selectable<ProgramsTable>;
export type ReservationRow = Selectable<ReservationsTable>;
export type ReleaseRow = Selectable<ReleasesTable>;
export type LedgerEntryRow = Selectable<LedgerEntriesTable>;
export type NewLedgerEntry = Insertable<LedgerEntriesTable>;
