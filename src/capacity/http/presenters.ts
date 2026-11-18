import { type CurrencyCode, formatFxRate, type MoneyJson } from '../../money';
import { type CapacityView } from '../application/capacity-queries';
import { type OpenDiscrepancy } from '../infrastructure/treasury.repository';
import {
  availableMinor,
  outstandingMinor,
  type Program,
  type Release,
  type Reservation,
} from '../domain/model';

function money(minor: bigint, currency: CurrencyCode): MoneyJson {
  return { amount: minor.toString(), currency };
}

export function presentCapacity(view: CapacityView) {
  const { program } = view;
  return {
    programId: program.id,
    currency: program.currency,
    limit: money(program.limitMinor, program.currency),
    utilised: money(program.utilisedMinor, program.currency),
    available: money(availableMinor(program), program.currency),
    overUtilised: view.overUtilised,
    openDiscrepancies: view.openDiscrepancies,
    version: program.version.toString(),
    updatedAt: program.updatedAt.toISOString(),
  };
}

export function presentReservation(program: Program, reservation: Reservation) {
  return {
    programId: reservation.programId,
    invoiceId: reservation.invoiceId,
    status: reservation.status,
    origin: reservation.origin,
    invoiceAmount: money(reservation.invoiceAmountMinor, reservation.invoiceCurrency),
    invoiceReleased: money(reservation.invoiceReleasedMinor, reservation.invoiceCurrency),
    booked: money(reservation.bookedMinor, program.currency),
    released: money(reservation.releasedMinor, program.currency),
    outstanding: money(outstandingMinor(reservation), program.currency),
    fx:
      reservation.fx === null
        ? null
        : {
            rate: formatFxRate(reservation.fx.rateScaled),
            source: reservation.fx.source,
            asOf: reservation.fx.asOf.toISOString(),
          },
    createdAt: reservation.createdAt.toISOString(),
    updatedAt: reservation.updatedAt.toISOString(),
  };
}

export function presentRelease(program: Program, reservation: Reservation, release: Release) {
  return {
    releaseId: release.releaseId,
    origin: release.origin,
    invoiceAmount: money(release.invoiceAmountMinor, reservation.invoiceCurrency),
    freed: money(release.freedMinor, program.currency),
    createdAt: release.createdAt.toISOString(),
  };
}

export function presentDiscrepancy(program: Program, discrepancy: OpenDiscrepancy) {
  return {
    invoiceId: discrepancy.invoiceId,
    kind: discrepancy.kind,
    localStatus: discrepancy.localStatus,
    localOutstanding:
      discrepancy.localOutstandingMinor === null
        ? null
        : money(discrepancy.localOutstandingMinor, program.currency),
    treasuryOutstanding:
      discrepancy.treasuryOutstandingMinor === null
        ? null
        : money(discrepancy.treasuryOutstandingMinor, program.currency),
    detail: discrepancy.detail,
    snapshotMessageId: discrepancy.snapshotMessageId,
    snapshotRevision: discrepancy.snapshotRevision.toString(),
    detectedAt: discrepancy.detectedAt.toISOString(),
    lastSeenAt: discrepancy.lastSeenAt.toISOString(),
  };
}
