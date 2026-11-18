import { z } from 'zod';
import { type CurrencyCode, isCurrencyCode } from './currency';
import { INT64_MAX } from './money';

export const currencySchema = z.custom<CurrencyCode>(
  (value) => typeof value === 'string' && isCurrencyCode(value),
  { message: 'Must be a supported ISO 4217 currency code' },
);

export const positiveMinorUnitsSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/, { message: 'Must be a positive integer string in minor units' })
  .max(19)
  .transform((value) => BigInt(value))
  .refine((value) => value <= INT64_MAX, { message: 'Amount exceeds the supported range' });

export const nonNegativeMinorUnitsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, { message: 'Must be a non-negative integer string in minor units' })
  .max(19)
  .transform((value) => BigInt(value))
  .refine((value) => value <= INT64_MAX, { message: 'Amount exceeds the supported range' });

export const moneySchema = z.strictObject({
  amount: positiveMinorUnitsSchema,
  currency: currencySchema,
});
