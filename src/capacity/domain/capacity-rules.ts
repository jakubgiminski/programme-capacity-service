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
  OverReleaseError,
  ReleaseCurrencyMismatchError,
  ReservationAlreadyReleasedError,
} from './errors';
import {
  availableMinor,
  type FxSnapshot,
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

export function isSameReservationRequest(existing: Reservation, invoiceAmount: Money): boolean {
  return (
    existing.invoiceCurrency === invoiceAmount.currency &&
    existing.invoiceAmountMinor === invoiceAmount.minor
  );
}

export function planBooking(program: Program, invoiceAmount: Money, rate: FxRate): BookingPlan {
  const bookedMinor = convertRoundingUp(invoiceAmount, rate);
  const available = availableMinor(program);
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
  const outstandingInvoice = outstandingInvoiceMinor(reservation);
  const amount = requested?.minor ?? outstandingInvoice;
  if (amount <= 0n || amount > outstandingInvoice) {
    throw new OverReleaseError(amount, outstandingInvoice);
  }
  const invoiceReleasedAfterMinor = reservation.invoiceReleasedMinor + amount;
  const releasedAfterMinor = cumulativeReleasedBooking(reservation, invoiceReleasedAfterMinor);
  return {
    invoiceAmountMinor: amount,
    freedMinor: releasedAfterMinor - reservation.releasedMinor,
    invoiceReleasedAfterMinor,
    releasedAfterMinor,
    status: releasedAfterMinor === reservation.bookedMinor ? 'RELEASED' : 'PARTIALLY_RELEASED',
  };
}

function cumulativeReleasedBooking(reservation: Reservation, invoiceReleasedAfter: bigint): bigint {
  if (invoiceReleasedAfter === reservation.invoiceAmountMinor) {
    return reservation.bookedMinor;
  }
  const share = proportionalShare(
    reservation.bookedMinor,
    invoiceReleasedAfter,
    reservation.invoiceAmountMinor,
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
