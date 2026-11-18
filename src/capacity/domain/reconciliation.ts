import { type CurrencyCode, INT64_MAX } from '../../money';
import { AmountOutOfRangeCapacityError } from './errors';
import {
  type AllocationBase,
  outstandingMinor,
  type Program,
  type Reservation,
  type ReservationStatus,
} from './model';

export type DiscrepancyKind =
  'TREASURY_AMOUNT_LOWER' | 'MISSING_FROM_SNAPSHOT' | 'RELEASED_LOCALLY' | 'INVOICE_MISMATCH';

export type AdjustmentReason =
  | 'IMPORTED_FROM_SNAPSHOT'
  | 'TREASURY_AMOUNT_HIGHER'
  | 'TREASURY_AMOUNT_LOWER'
  | 'MISSING_FROM_SNAPSHOT';

export interface SnapshotReservation {
  readonly invoiceId: string;
  readonly invoiceAmountMinor: bigint;
  readonly invoiceCurrency: CurrencyCode;
  readonly bookedMinor: bigint;
}

export interface Snapshot {
  readonly limitMinor: bigint;
  readonly reservations: readonly SnapshotReservation[];
}

export interface ReservationImport {
  readonly kind: 'import';
  readonly entry: SnapshotReservation;
  readonly deltaMinor: bigint;
  readonly reason: 'IMPORTED_FROM_SNAPSHOT';
}

export interface ReservationAdjustment {
  readonly kind: 'adjust';
  readonly reservation: Reservation;
  readonly bookedAfterMinor: bigint;
  readonly releasedAfterMinor: bigint;
  readonly invoiceReleasedAfterMinor: bigint;
  readonly allocationBase: AllocationBase;
  readonly status: ReservationStatus;
  readonly deltaMinor: bigint;
  readonly reason: Exclude<AdjustmentReason, 'IMPORTED_FROM_SNAPSHOT'>;
}

export interface Discrepancy {
  readonly invoiceId: string;
  readonly kind: DiscrepancyKind;
  readonly localStatus: ReservationStatus;
  readonly localOutstandingMinor: bigint;
  readonly treasuryOutstandingMinor: bigint | null;
  readonly detail: string;
}

export type ReconciliationChange = ReservationImport | ReservationAdjustment;

export interface ReconciliationPlan {
  readonly limitMinor: bigint;
  readonly utilisedAfterMinor: bigint;
  readonly changes: readonly ReconciliationChange[];
  readonly discrepancies: readonly Discrepancy[];
}

export function planReconciliation(
  program: Program,
  local: readonly Reservation[],
  snapshot: Snapshot,
): ReconciliationPlan {
  const localByInvoice = new Map(local.map((reservation) => [reservation.invoiceId, reservation]));
  const snapshotInvoices = new Set(snapshot.reservations.map((entry) => entry.invoiceId));
  const changes: ReconciliationChange[] = [];
  const discrepancies: Discrepancy[] = [];

  for (const entry of snapshot.reservations) {
    const reservation = localByInvoice.get(entry.invoiceId);
    if (reservation === undefined) {
      changes.push({
        kind: 'import',
        entry,
        deltaMinor: entry.bookedMinor,
        reason: 'IMPORTED_FROM_SNAPSHOT',
      });
      continue;
    }
    reconcileKnown(reservation, entry, changes, discrepancies);
  }

  for (const reservation of local) {
    if (snapshotInvoices.has(reservation.invoiceId) || reservation.status === 'RELEASED') {
      continue;
    }
    reconcileMissing(reservation, changes, discrepancies);
  }

  const utilisedAfterMinor = changes.reduce(
    (total, change) => total + change.deltaMinor,
    program.utilisedMinor,
  );
  if (utilisedAfterMinor > INT64_MAX) {
    throw new AmountOutOfRangeCapacityError('Snapshot would push utilisation beyond BIGINT range');
  }
  return {
    limitMinor: snapshot.limitMinor,
    utilisedAfterMinor,
    changes: [...changes].sort(decreasesFirst),
    discrepancies: [...discrepancies].sort((a, b) => compareText(a.invoiceId, b.invoiceId)),
  };
}

function reconcileKnown(
  reservation: Reservation,
  entry: SnapshotReservation,
  changes: ReconciliationChange[],
  discrepancies: Discrepancy[],
): void {
  if (reservation.status === 'RELEASED') {
    discrepancies.push(
      discrepancy(
        reservation,
        'RELEASED_LOCALLY',
        entry.bookedMinor,
        'Released locally but active in treasury',
      ),
    );
    return;
  }
  if (
    reservation.invoiceCurrency !== entry.invoiceCurrency ||
    reservation.invoiceAmountMinor !== entry.invoiceAmountMinor
  ) {
    discrepancies.push(
      discrepancy(
        reservation,
        'INVOICE_MISMATCH',
        entry.bookedMinor,
        `Local invoice ${reservation.invoiceAmountMinor} ${reservation.invoiceCurrency}, treasury ${entry.invoiceAmountMinor} ${entry.invoiceCurrency}`,
      ),
    );
  }

  const local = outstandingMinor(reservation);
  if (entry.bookedMinor > local) {
    changes.push(rebook(reservation, entry.bookedMinor, 'TREASURY_AMOUNT_HIGHER'));
    return;
  }
  if (entry.bookedMinor === local) {
    return;
  }
  if (reservation.origin === 'TREASURY') {
    changes.push(rebook(reservation, entry.bookedMinor, 'TREASURY_AMOUNT_LOWER'));
    return;
  }
  discrepancies.push(
    discrepancy(
      reservation,
      'TREASURY_AMOUNT_LOWER',
      entry.bookedMinor,
      'Treasury reports a lower booked amount for an API reservation; kept the local amount',
    ),
  );
}

function reconcileMissing(
  reservation: Reservation,
  changes: ReconciliationChange[],
  discrepancies: Discrepancy[],
): void {
  if (reservation.origin === 'TREASURY') {
    changes.push({
      kind: 'adjust',
      reservation,
      bookedAfterMinor: reservation.bookedMinor,
      releasedAfterMinor: reservation.bookedMinor,
      invoiceReleasedAfterMinor: reservation.invoiceAmountMinor,
      allocationBase: reservation.allocationBase,
      status: 'RELEASED',
      deltaMinor: -outstandingMinor(reservation),
      reason: 'MISSING_FROM_SNAPSHOT',
    });
    return;
  }
  discrepancies.push(
    discrepancy(
      reservation,
      'MISSING_FROM_SNAPSHOT',
      null,
      'Active API reservation is missing from the treasury snapshot; kept the local amount',
    ),
  );
}

function rebook(
  reservation: Reservation,
  treasuryOutstandingMinor: bigint,
  reason: 'TREASURY_AMOUNT_HIGHER' | 'TREASURY_AMOUNT_LOWER',
): ReservationAdjustment {
  const bookedAfterMinor = reservation.releasedMinor + treasuryOutstandingMinor;
  if (bookedAfterMinor > INT64_MAX) {
    throw new AmountOutOfRangeCapacityError('Snapshot booked amount exceeds BIGINT range');
  }
  return {
    kind: 'adjust',
    reservation,
    bookedAfterMinor,
    releasedAfterMinor: reservation.releasedMinor,
    invoiceReleasedAfterMinor: reservation.invoiceReleasedMinor,
    allocationBase: {
      invoiceReleasedMinor: reservation.invoiceReleasedMinor,
      releasedMinor: reservation.releasedMinor,
    },
    status: reservation.status,
    deltaMinor: treasuryOutstandingMinor - outstandingMinor(reservation),
    reason,
  };
}

function discrepancy(
  reservation: Reservation,
  kind: DiscrepancyKind,
  treasuryOutstandingMinor: bigint | null,
  detail: string,
): Discrepancy {
  return {
    invoiceId: reservation.invoiceId,
    kind,
    localStatus: reservation.status,
    localOutstandingMinor: outstandingMinor(reservation),
    treasuryOutstandingMinor,
    detail,
  };
}

function invoiceIdOf(change: ReconciliationChange): string {
  return change.kind === 'import' ? change.entry.invoiceId : change.reservation.invoiceId;
}

function decreasesFirst(a: ReconciliationChange, b: ReconciliationChange): number {
  const direction = Number(a.deltaMinor >= 0n) - Number(b.deltaMinor >= 0n);
  if (direction !== 0) {
    return direction;
  }
  return compareText(invoiceIdOf(a), invoiceIdOf(b));
}

function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
