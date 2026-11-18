import { currencyExponent } from './currency';
import { assertValidScaledRate, type FxRate, FX_RATE_SCALE } from './fx-rate';
import { Money } from './money';
import { CurrencyMismatchError, InvalidAmountError } from './money-errors';
import { divide, type RoundingMode } from './rounding';

export function convert(amount: Money, rate: FxRate, mode: RoundingMode): Money {
  if (amount.currency !== rate.from) {
    throw new CurrencyMismatchError(rate.from, amount.currency);
  }
  assertValidScaledRate(rate.scaled);
  if (amount.isNegative()) {
    throw new InvalidAmountError('Only non-negative amounts can be converted');
  }
  const numerator = amount.minor * rate.scaled * 10n ** BigInt(currencyExponent(rate.to));
  const denominator = FX_RATE_SCALE * 10n ** BigInt(currencyExponent(rate.from));
  return Money.of(divide(numerator, denominator, mode), rate.to);
}
