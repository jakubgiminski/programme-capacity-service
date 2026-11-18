import {
  AmountOutOfRangeError,
  convert,
  FX_RATE_SCALE_DIGITS,
  type FxRate,
  type Money,
  proportionalShare,
} from '../../money';
import {
  AmountOutOfRangeCapacityError,
  InsufficientCapacityError,
  InvalidAmountCapacityError,
  InvoiceConflictError,
  OverReleaseError,
  ReleaseCurrencyMismatchError,
  ReservationAlreadyReleasedError,
  TreasuryOwnedReservationError,
} from './errors';
import {
  type FxSnapshot,
  type Origin,
  outstandingInvoiceMinor,
  type Program,
  type Reservation,
  type ReservationStatus,
} from './model';

export interface BookingPlan {
  readonly bookedMinor: bigint;
  readonly fx: FxSnapshot;
}

export interface ReleasePlan {
  readonly invoiceAmountMinor: bigint;
  readonly freedMinor: bigint;
  readonly invoiceReleasedAfterMinor: bigint;
  readonly releasedAfterMinor: bigint;
  readonly status: ReservationStatus;
}

export function assertReplayableReservation(existing: Reservation, invoiceAmount: Money): void {
  if (existing.origin !== 'API') {
    throw new InvoiceConflictError(
      existing.invoiceId,
      `Invoice ${existing.invoiceId} is already tracked from treasury and cannot be reserved through the API`,
    );
  }
  if (
    existing.invoiceCurrency !== invoiceAmount.currency ||
    existing.invoiceAmountMinor !== invoiceAmount.minor
  ) {
    throw new InvoiceConflictError(existing.invoiceId);
  }
}

export function assertReleasableBy(reservation: Reservation, origin: Origin): void {
  if (origin === 'API' && reservation.origin === 'TREASURY') {
    throw new TreasuryOwnedReservationError(reservation.invoiceId);
  }
}

export function admissionLimitMinor(program: Program, pendingLimitMinor: bigint | null): bigint {
  if (pendingLimitMinor === null || pendingLimitMinor >= program.limitMinor) {
    return program.limitMinor;
  }
  return pendingLimitMinor;
}

export function assertPositiveAmount(amount: Money): void {
  if (!amount.isPositive()) {
    throw new InvalidAmountCapacityError('Amount must be greater than zero');
  }
}

export function planBooking(
  program: Program,
  invoiceAmount: Money,
  rate: FxRate,
  pendingLimitMinor: bigint | null,
): BookingPlan {
  assertPositiveAmount(invoiceAmount);
  const bookedMinor = convertRoundingUp(invoiceAmount, rate);
  const available = admissionLimitMinor(program, pendingLimitMinor) - program.utilisedMinor;
  if (bookedMinor > available) {
    throw new InsufficientCapacityError(bookedMinor, available, program.currency);
  }
  return {
    bookedMinor,
    fx: {
      rateScaled: rate.scaled,
      scale: FX_RATE_SCALE_DIGITS,
      source: rate.source,
      asOf: rate.asOf,
    },
  };
}

export function planRelease(reservation: Reservation, requested: Money | null): ReleasePlan {
  if (reservation.status === 'RELEASED') {
    throw new ReservationAlreadyReleasedError(reservation.invoiceId);
  }
  if (requested !== null && requested.currency !== reservation.invoiceCurrency) {
    throw new ReleaseCurrencyMismatchError(reservation.invoiceCurrency, requested.currency);
  }
  if (requested !== null) {
    assertPositiveAmount(requested);
  }
  const outstandingInvoice = outstandingInvoiceMinor(reservation);
  const amount = requested?.minor ?? outstandingInvoice;
  if (amount > outstandingInvoice) {
    throw new OverReleaseError(amount, outstandingInvoice);
  }
  const invoiceReleasedAfterMinor = reservation.invoiceReleasedMinor + amount;
  const releasedAfterMinor = cumulativeReleasedBooking(reservation, invoiceReleasedAfterMinor);
  return {
    invoiceAmountMinor: amount,
    freedMinor: releasedAfterMinor - reservation.releasedMinor,
    invoiceReleasedAfterMinor,
    releasedAfterMinor,
    status:
      invoiceReleasedAfterMinor === reservation.invoiceAmountMinor
        ? 'RELEASED'
        : 'PARTIALLY_RELEASED',
  };
}

function cumulativeReleasedBooking(reservation: Reservation, invoiceReleasedAfter: bigint): bigint {
  if (invoiceReleasedAfter === reservation.invoiceAmountMinor) {
    return reservation.bookedMinor;
  }
  const base = reservation.allocationBase;
  const share =
    base.releasedMinor +
    proportionalShare(
      reservation.bookedMinor - base.releasedMinor,
      invoiceReleasedAfter - base.invoiceReleasedMinor,
      reservation.invoiceAmountMinor - base.invoiceReleasedMinor,
      'DOWN',
    );
  return share < reservation.releasedMinor ? reservation.releasedMinor : share;
}

function convertRoundingUp(invoiceAmount: Money, rate: FxRate): bigint {
  try {
    return convert(invoiceAmount, rate, 'UP').minor;
  } catch (error) {
    if (error instanceof AmountOutOfRangeError) {
      throw new AmountOutOfRangeCapacityError(error.message);
    }
    throw error;
  }
}
