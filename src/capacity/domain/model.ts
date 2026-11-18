import { type CurrencyCode } from '../../money';

export type ReservationStatus = 'ACTIVE' | 'PARTIALLY_RELEASED' | 'RELEASED';
export type Origin = 'API' | 'TREASURY';

export interface Program {
  readonly id: string;
  readonly currency: CurrencyCode;
  readonly limitMinor: bigint;
  readonly utilisedMinor: bigint;
  readonly version: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FxSnapshot {
  readonly rateScaled: bigint;
  readonly scale: number;
  readonly source: string;
  readonly asOf: Date;
}

export interface AllocationBase {
  readonly invoiceReleasedMinor: bigint;
  readonly releasedMinor: bigint;
}

export const ZERO_ALLOCATION_BASE: AllocationBase = { invoiceReleasedMinor: 0n, releasedMinor: 0n };

export interface Reservation {
  readonly id: string;
  readonly programId: string;
  readonly invoiceId: string;
  readonly status: ReservationStatus;
  readonly origin: Origin;
  readonly invoiceAmountMinor: bigint;
  readonly invoiceCurrency: CurrencyCode;
  readonly invoiceReleasedMinor: bigint;
  readonly bookedMinor: bigint;
  readonly releasedMinor: bigint;
  readonly allocationBase: AllocationBase;
  readonly fx: FxSnapshot | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Release {
  readonly id: string;
  readonly reservationId: string;
  readonly releaseId: string;
  readonly requestedInvoiceAmountMinor: bigint | null;
  readonly invoiceAmountMinor: bigint;
  readonly freedMinor: bigint;
  readonly origin: Origin;
  readonly actor: string;
  readonly sequence: bigint;
  readonly statusAfter: ReservationStatus;
  readonly invoiceReleasedAfterMinor: bigint;
  readonly bookedAfterMinor: bigint;
  readonly releasedAfterMinor: bigint;
  readonly createdAt: Date;
}

export function availableMinor(program: Program): bigint {
  return program.limitMinor - program.utilisedMinor;
}

export function outstandingMinor(reservation: Reservation): bigint {
  return reservation.bookedMinor - reservation.releasedMinor;
}

export function outstandingInvoiceMinor(reservation: Reservation): bigint {
  return reservation.invoiceAmountMinor - reservation.invoiceReleasedMinor;
}

export function reservationAfterRelease(reservation: Reservation, release: Release): Reservation {
  return {
    ...reservation,
    status: release.statusAfter,
    invoiceReleasedMinor: release.invoiceReleasedAfterMinor,
    bookedMinor: release.bookedAfterMinor,
    releasedMinor: release.releasedAfterMinor,
    updatedAt: release.createdAt,
  };
}
