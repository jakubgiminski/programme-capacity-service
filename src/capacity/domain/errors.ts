export abstract class CapacityError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ProgramNotFoundError extends CapacityError {
  readonly code = 'program-not-found';

  constructor(readonly programId: string) {
    super(`Programme ${programId} does not exist`);
  }
}

export class ReservationNotFoundError extends CapacityError {
  readonly code = 'reservation-not-found';

  constructor(
    readonly programId: string,
    readonly invoiceId: string,
  ) {
    super(`No reservation for invoice ${invoiceId} in programme ${programId}`);
  }
}

export class InvoiceConflictError extends CapacityError {
  readonly code = 'invoice-conflict';

  constructor(
    readonly invoiceId: string,
    message = `Invoice ${invoiceId} already has a reservation with a different amount or currency`,
  ) {
    super(message);
  }
}

export class TreasuryOwnedReservationError extends CapacityError {
  readonly code = 'treasury-owned-reservation';

  constructor(readonly invoiceId: string) {
    super(
      `Invoice ${invoiceId} is tracked from treasury and is released only by treasury messages`,
    );
  }
}

export class InsufficientCapacityError extends CapacityError {
  readonly code = 'insufficient-capacity';

  constructor(
    readonly requestedMinor: bigint,
    readonly availableMinor: bigint,
    readonly currency: string,
  ) {
    super(
      `Reservation of ${requestedMinor} ${currency} minor units exceeds available capacity of ${availableMinor}`,
    );
  }
}

export class FxRateUnavailableError extends CapacityError {
  readonly code = 'fx-rate-unavailable';

  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`No FX rate available for ${from} to ${to}`);
  }
}

export class OverReleaseError extends CapacityError {
  readonly code = 'over-release';

  constructor(
    readonly requestedMinor: bigint,
    readonly outstandingMinor: bigint,
  ) {
    super(
      `Release of ${requestedMinor} exceeds the outstanding invoice amount of ${outstandingMinor}`,
    );
  }
}

export class ReleaseCurrencyMismatchError extends CapacityError {
  readonly code = 'release-currency-mismatch';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Release must be in the invoice currency ${expected}, got ${actual}`);
  }
}

export class ReleaseConflictError extends CapacityError {
  readonly code = 'release-conflict';

  constructor(readonly releaseId: string) {
    super(`Release ${releaseId} was already used with a different amount`);
  }
}

export class ReservationAlreadyReleasedError extends CapacityError {
  readonly code = 'reservation-already-released';

  constructor(readonly invoiceId: string) {
    super(`Reservation for invoice ${invoiceId} is already fully released`);
  }
}

export class AmountOutOfRangeCapacityError extends CapacityError {
  readonly code = 'amount-out-of-range';
}

export class InvalidAmountCapacityError extends CapacityError {
  readonly code = 'invalid-amount';
}
