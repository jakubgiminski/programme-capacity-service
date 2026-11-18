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
  allocation_base_invoice_minor: Generated<bigint>;
  allocation_base_released_minor: Generated<bigint>;
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
  sequence: bigint;
  status_after: ReservationStatus;
  invoice_released_after_minor: bigint;
  booked_after_minor: bigint;
  released_after_minor: bigint;
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

export type MessageOutcome = 'APPLIED' | 'PARKED' | 'STALE' | 'REJECTED' | 'SUPERSEDED';
export type DiscrepancyKind =
  'TREASURY_AMOUNT_LOWER' | 'MISSING_FROM_SNAPSHOT' | 'RELEASED_LOCALLY' | 'INVOICE_MISMATCH';

export interface ProcessedMessagesTable {
  message_id: string;
  program_id: string;
  revision: bigint;
  type: string;
  outcome: MessageOutcome;
  reason: string | null;
  source_topic: string;
  source_partition: number;
  source_offset: string;
  received_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface PendingTreasuryMessagesTable {
  message_id: string;
  program_id: string;
  revision: bigint;
  raw_value: string;
  rejected: Generated<boolean>;
  source_topic: string;
  source_partition: number;
  source_offset: string;
  received_at: CreatedAt;
}

export interface TreasuryStreamsTable {
  program_id: string;
  revision: Generated<bigint>;
  updated_at: UpdatedAt;
}

export interface TreasuryDeadLettersTable {
  id: Generated<bigint>;
  message_id: string | null;
  program_id: string | null;
  revision: bigint | null;
  reason: string;
  message_key: Buffer | null;
  payload: Buffer;
  source_topic: string;
  source_partition: number;
  source_offset: string;
  attempts: Generated<number>;
  last_error: string | null;
  created_at: CreatedAt;
  published_at: Date | null;
}

export interface ReconciliationDiscrepanciesTable {
  id: Generated<string>;
  program_id: string;
  invoice_id: string;
  kind: DiscrepancyKind;
  local_status: string | null;
  local_outstanding_minor: bigint | null;
  treasury_outstanding_minor: bigint | null;
  detail: string | null;
  snapshot_message_id: string;
  snapshot_revision: bigint;
  detected_at: CreatedAt;
  last_seen_at: UpdatedAt;
  resolved_at: Date | null;
}

export interface Database {
  programs: ProgramsTable;
  reservations: ReservationsTable;
  releases: ReleasesTable;
  ledger_entries: LedgerEntriesTable;
  processed_messages: ProcessedMessagesTable;
  pending_treasury_messages: PendingTreasuryMessagesTable;
  treasury_streams: TreasuryStreamsTable;
  treasury_dead_letters: TreasuryDeadLettersTable;
  reconciliation_discrepancies: ReconciliationDiscrepanciesTable;
}

export type ProgramRow = Selectable<ProgramsTable>;
export type ReservationRow = Selectable<ReservationsTable>;
export type ReleaseRow = Selectable<ReleasesTable>;
export type LedgerEntryRow = Selectable<LedgerEntriesTable>;
export type NewLedgerEntry = Insertable<LedgerEntriesTable>;
