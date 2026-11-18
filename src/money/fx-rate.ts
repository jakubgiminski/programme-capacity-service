import { type CurrencyCode } from './currency';
import { INT64_MAX } from './money';
import { InvalidFxRateError } from './money-errors';

export const FX_RATE_SCALE_DIGITS = 10;
export const FX_RATE_SCALE = 10n ** BigInt(FX_RATE_SCALE_DIGITS);

const DECIMAL_RATE = /^(0|[1-9][0-9]*)(\.([0-9]+))?$/;

export interface FxRate {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  readonly scaled: bigint;
  readonly source: string;
  readonly asOf: Date;
}

export function parseFxRate(value: string): bigint {
  const match = DECIMAL_RATE.exec(value);
  if (match === null) {
    throw new InvalidFxRateError(`FX rate must be a positive decimal string, got "${value}"`);
  }
  const fraction = match[3] ?? '';
  if (fraction.length > FX_RATE_SCALE_DIGITS) {
    throw new InvalidFxRateError(
      `FX rate supports at most ${FX_RATE_SCALE_DIGITS} decimal places, got "${value}"`,
    );
  }
  const integer = match[1] ?? '0';
  const scaled = BigInt(integer + fraction.padEnd(FX_RATE_SCALE_DIGITS, '0'));
  if (scaled === 0n) {
    throw new InvalidFxRateError('FX rate must be greater than zero');
  }
  if (scaled > INT64_MAX) {
    throw new InvalidFxRateError(`FX rate ${value} is too large`);
  }
  return scaled;
}

export function formatFxRate(scaled: bigint): string {
  const integer = scaled / FX_RATE_SCALE;
  const fraction = (scaled % FX_RATE_SCALE)
    .toString()
    .padStart(FX_RATE_SCALE_DIGITS, '0')
    .replace(/0+$/, '');
  if (fraction.length === 0) {
    return integer.toString();
  }
  return `${integer}.${fraction}`;
}

export function identityRate(currency: CurrencyCode, asOf: Date): FxRate {
  return { from: currency, to: currency, scaled: FX_RATE_SCALE, source: 'identity', asOf };
}
