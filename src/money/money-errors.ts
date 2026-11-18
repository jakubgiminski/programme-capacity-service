export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnknownCurrencyError extends MoneyError {
  constructor(readonly code: string) {
    super(`Unknown or unsupported ISO 4217 currency: ${code}`);
  }
}

export class CurrencyMismatchError extends MoneyError {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InvalidAmountError extends MoneyError {}

export class AmountOutOfRangeError extends MoneyError {}

export class InvalidFxRateError extends MoneyError {}
