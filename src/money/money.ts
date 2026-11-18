import { type CurrencyCode } from './currency';
import { AmountOutOfRangeError, CurrencyMismatchError, InvalidAmountError } from './money-errors';

export const INT64_MAX = 9_223_372_036_854_775_807n;
export const INT64_MIN = -9_223_372_036_854_775_808n;

const NON_NEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;

export interface MoneyJson {
  amount: string;
  currency: string;
}

function assertInt64(value: bigint): bigint {
  if (value > INT64_MAX || value < INT64_MIN) {
    throw new AmountOutOfRangeError(`Amount ${value} is outside the supported 64-bit range`);
  }
  return value;
}

const MAX_INT64_DIGITS = 19;

export function parseMinorUnits(value: string): bigint {
  if (value.length > MAX_INT64_DIGITS) {
    throw new AmountOutOfRangeError('Amount is outside the supported 64-bit range');
  }
  if (!NON_NEGATIVE_INTEGER.test(value)) {
    throw new InvalidAmountError('Amount must be a non-negative integer string in minor units');
  }
  return assertInt64(BigInt(value));
}

export class Money {
  private constructor(
    readonly minor: bigint,
    readonly currency: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  static of(minor: bigint, currency: CurrencyCode): Money {
    return new Money(assertInt64(minor), currency);
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.minor - other.minor, this.currency);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minor < other.minor) {
      return -1;
    }
    if (this.minor > other.minor) {
      return 1;
    }
    return 0;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor === other.minor;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  toJSON(): MoneyJson {
    return { amount: this.minor.toString(), currency: this.currency };
  }

  toString(): string {
    return `${this.minor} ${this.currency} (minor units)`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
