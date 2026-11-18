import { Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { type Database, type NewLedgerEntry } from '../../database/database.types';
import { type CurrencyCode, parseCurrency } from '../../money';
import {
  type AllocationBase,
  type FxSnapshot,
  type Origin,
  type Program,
  type Release,
  type Reservation,
  type ReservationStatus,
} from '../domain/model';

type Executor = Kysely<Database>;

export interface NewProgram {
  id: string;
  currency: CurrencyCode;
  limitMinor: bigint;
}

export interface NewReservation {
  programId: string;
  invoiceId: string;
  origin: Origin;
  invoiceAmountMinor: bigint;
  invoiceCurrency: CurrencyCode;
  bookedMinor: bigint;
  fx: FxSnapshot | null;
}

export interface ReservationBalances {
  status: ReservationStatus;
  invoiceReleasedMinor: bigint;
  bookedMinor: bigint;
  releasedMinor: bigint;
  allocationBase?: AllocationBase;
}

export interface NewRelease {
  reservationId: string;
  releaseId: string;
  requestedInvoiceAmountMinor: bigint | null;
  invoiceAmountMinor: bigint;
  freedMinor: bigint;
  origin: Origin;
  actor: string;
  sequence: bigint;
  statusAfter: ReservationStatus;
  invoiceReleasedAfterMinor: bigint;
  bookedAfterMinor: bigint;
  releasedAfterMinor: bigint;
  createdAt: Date;
}

export interface ProgramBalances {
  limitMinor: bigint;
  utilisedMinor: bigint;
}

const programColumns = [
  'id',
  'currency',
  'limit_minor',
  'utilised_minor',
  'version',
  'created_at',
  'updated_at',
] as const;

interface ProgramRecord {
  id: string;
  currency: string;
  limit_minor: bigint;
  utilised_minor: bigint;
  version: bigint;
  created_at: Date;
  updated_at: Date;
}

interface ReservationRecord {
  id: string;
  program_id: string;
  invoice_id: string;
  status: ReservationStatus;
  origin: Origin;
  invoice_amount_minor: bigint;
  invoice_currency: string;
  invoice_released_minor: bigint;
  booked_minor: bigint;
  released_minor: bigint;
  allocation_base_invoice_minor: bigint;
  allocation_base_released_minor: bigint;
  fx_rate: bigint | null;
  fx_scale: number | null;
  fx_source: string | null;
  fx_as_of: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ReleaseRecord {
  id: string;
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
  created_at: Date;
}

function toProgram(row: ProgramRecord): Program {
  return {
    id: row.id,
    currency: parseCurrency(row.currency),
    limitMinor: row.limit_minor,
    utilisedMinor: row.utilised_minor,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFxSnapshot(row: ReservationRecord): FxSnapshot | null {
  if (
    row.fx_rate === null ||
    row.fx_scale === null ||
    row.fx_source === null ||
    row.fx_as_of === null
  ) {
    return null;
  }
  return {
    rateScaled: row.fx_rate,
    scale: row.fx_scale,
    source: row.fx_source,
    asOf: row.fx_as_of,
  };
}

function toReservation(row: ReservationRecord): Reservation {
  return {
    id: row.id,
    programId: row.program_id,
    invoiceId: row.invoice_id,
    status: row.status,
    origin: row.origin,
    invoiceAmountMinor: row.invoice_amount_minor,
    invoiceCurrency: parseCurrency(row.invoice_currency),
    invoiceReleasedMinor: row.invoice_released_minor,
    bookedMinor: row.booked_minor,
    releasedMinor: row.released_minor,
    allocationBase: {
      invoiceReleasedMinor: row.allocation_base_invoice_minor,
      releasedMinor: row.allocation_base_released_minor,
    },
    fx: toFxSnapshot(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRelease(row: ReleaseRecord): Release {
  return {
    id: row.id,
    reservationId: row.reservation_id,
    releaseId: row.release_id,
    requestedInvoiceAmountMinor: row.requested_invoice_amount_minor,
    invoiceAmountMinor: row.invoice_amount_minor,
    freedMinor: row.freed_minor,
    origin: row.origin,
    actor: row.actor,
    sequence: row.sequence,
    statusAfter: row.status_after,
    invoiceReleasedAfterMinor: row.invoice_released_after_minor,
    bookedAfterMinor: row.booked_after_minor,
    releasedAfterMinor: row.released_after_minor,
    createdAt: row.created_at,
  };
}

const INSERT_CHUNK = 1_000;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

function reservationValues(reservation: NewReservation) {
  return {
    program_id: reservation.programId,
    invoice_id: reservation.invoiceId,
    status: 'ACTIVE' as const,
    origin: reservation.origin,
    invoice_amount_minor: reservation.invoiceAmountMinor,
    invoice_currency: reservation.invoiceCurrency,
    booked_minor: reservation.bookedMinor,
    fx_rate: reservation.fx?.rateScaled ?? null,
    fx_scale: reservation.fx?.scale ?? null,
    fx_source: reservation.fx?.source ?? null,
    fx_as_of: reservation.fx?.asOf ?? null,
  };
}

@Injectable()
export class CapacityRepository {
  async findProgram(db: Executor, programId: string): Promise<Program | null> {
    const row = await db
      .selectFrom('programs')
      .select(programColumns)
      .where('id', '=', programId)
      .executeTakeFirst();
    return row === undefined ? null : toProgram(row);
  }

  async lockProgram(db: Executor, programId: string): Promise<Program | null> {
    const row = await db
      .selectFrom('programs')
      .select(programColumns)
      .where('id', '=', programId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : toProgram(row);
  }

  async insertProgram(db: Executor, program: NewProgram): Promise<Program> {
    const row = await db
      .insertInto('programs')
      .values({
        id: program.id,
        currency: program.currency,
        limit_minor: program.limitMinor,
      })
      .returning(programColumns)
      .executeTakeFirstOrThrow();
    return toProgram(row);
  }

  async updateProgram(db: Executor, program: Program, next: ProgramBalances): Promise<Program> {
    const row = await db
      .updateTable('programs')
      .set({
        limit_minor: next.limitMinor,
        utilised_minor: next.utilisedMinor,
        version: program.version + 1n,
        updated_at: new Date(),
      })
      .where('id', '=', program.id)
      .where('version', '=', program.version)
      .returning(programColumns)
      .executeTakeFirstOrThrow();
    return toProgram(row);
  }

  async findReservation(
    db: Executor,
    programId: string,
    invoiceId: string,
  ): Promise<Reservation | null> {
    const row = await db
      .selectFrom('reservations')
      .selectAll()
      .where('program_id', '=', programId)
      .where('invoice_id', '=', invoiceId)
      .executeTakeFirst();
    return row === undefined ? null : toReservation(row);
  }

  async listOpenReservations(db: Executor, programId: string): Promise<Reservation[]> {
    const rows = await db
      .selectFrom('reservations')
      .selectAll()
      .where('program_id', '=', programId)
      .where('status', '<>', 'RELEASED')
      .orderBy('invoice_id')
      .execute();
    return rows.map(toReservation);
  }

  async listReservationsForReconciliation(
    db: Executor,
    programId: string,
    invoiceIds: readonly string[],
  ): Promise<Reservation[]> {
    const rows = await db
      .selectFrom('reservations')
      .selectAll()
      .where('program_id', '=', programId)
      .where((eb) =>
        eb.or([
          eb('status', '<>', 'RELEASED'),
          sql<boolean>`invoice_id = any(${[...invoiceIds]}::text[])`,
        ]),
      )
      .orderBy('invoice_id')
      .execute();
    return rows.map(toReservation);
  }

  async insertReservation(db: Executor, reservation: NewReservation): Promise<Reservation> {
    const row = await db
      .insertInto('reservations')
      .values(reservationValues(reservation))
      .returningAll()
      .executeTakeFirstOrThrow();
    return toReservation(row);
  }

  async updateReservation(
    db: Executor,
    reservationId: string,
    balances: ReservationBalances,
    updatedAt: Date = new Date(),
  ): Promise<Reservation> {
    const row = await db
      .updateTable('reservations')
      .set({
        status: balances.status,
        invoice_released_minor: balances.invoiceReleasedMinor,
        booked_minor: balances.bookedMinor,
        released_minor: balances.releasedMinor,
        ...(balances.allocationBase === undefined
          ? {}
          : {
              allocation_base_invoice_minor: balances.allocationBase.invoiceReleasedMinor,
              allocation_base_released_minor: balances.allocationBase.releasedMinor,
            }),
        updated_at: updatedAt,
      })
      .where('id', '=', reservationId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toReservation(row);
  }

  async findRelease(
    db: Executor,
    reservationId: string,
    releaseId: string,
  ): Promise<Release | null> {
    const row = await db
      .selectFrom('releases')
      .selectAll()
      .where('reservation_id', '=', reservationId)
      .where('release_id', '=', releaseId)
      .executeTakeFirst();
    return row === undefined ? null : toRelease(row);
  }

  async listReleases(db: Executor, reservationId: string): Promise<Release[]> {
    const rows = await db
      .selectFrom('releases')
      .selectAll()
      .where('reservation_id', '=', reservationId)
      .orderBy('sequence')
      .execute();
    return rows.map(toRelease);
  }

  async insertRelease(db: Executor, release: NewRelease): Promise<Release> {
    const row = await db
      .insertInto('releases')
      .values({
        reservation_id: release.reservationId,
        release_id: release.releaseId,
        requested_invoice_amount_minor: release.requestedInvoiceAmountMinor,
        invoice_amount_minor: release.invoiceAmountMinor,
        freed_minor: release.freedMinor,
        origin: release.origin,
        actor: release.actor,
        sequence: release.sequence,
        status_after: release.statusAfter,
        invoice_released_after_minor: release.invoiceReleasedAfterMinor,
        booked_after_minor: release.bookedAfterMinor,
        released_after_minor: release.releasedAfterMinor,
        created_at: release.createdAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRelease(row);
  }

  async insertReservations(
    db: Executor,
    reservations: readonly NewReservation[],
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const chunk of chunks(reservations, INSERT_CHUNK)) {
      const rows = await db
        .insertInto('reservations')
        .values(chunk.map(reservationValues))
        .returning(['id', 'invoice_id'])
        .execute();
      for (const row of rows) {
        ids.set(row.invoice_id, row.id);
      }
    }
    return ids;
  }

  async appendLedger(db: Executor, entries: readonly NewLedgerEntry[]): Promise<void> {
    for (const chunk of chunks(entries, INSERT_CHUNK)) {
      await db.insertInto('ledger_entries').values(chunk).execute();
    }
  }
}
