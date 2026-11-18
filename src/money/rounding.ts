import { InvalidAmountError } from './money-errors';

export type RoundingMode = 'UP' | 'DOWN';

export function divide(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (numerator < 0n) {
    throw new InvalidAmountError('Numerator must be non-negative');
  }
  if (denominator <= 0n) {
    throw new InvalidAmountError('Denominator must be positive');
  }
  const quotient = numerator / denominator;
  if (mode === 'DOWN') {
    return quotient;
  }
  return numerator % denominator === 0n ? quotient : quotient + 1n;
}

export function proportionalShare(
  total: bigint,
  part: bigint,
  whole: bigint,
  mode: RoundingMode,
): bigint {
  if (total < 0n || part < 0n || part > whole) {
    throw new InvalidAmountError('Proportional share requires 0 <= part <= whole and total >= 0');
  }
  return divide(total * part, whole, mode);
}
