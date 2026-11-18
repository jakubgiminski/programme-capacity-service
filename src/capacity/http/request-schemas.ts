import { z } from 'zod';
import { moneySchema } from '../../money';

export const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/, { message: 'Must be 1-64 characters of [A-Za-z0-9._:-]' });

export const reserveBodySchema = z.strictObject({
  invoiceId: identifierSchema,
  amount: moneySchema,
});

export const releaseBodySchema = z.strictObject({
  releaseId: identifierSchema,
  amount: moneySchema.optional(),
});

export type ReserveBody = z.output<typeof reserveBodySchema>;
export type ReleaseBody = z.output<typeof releaseBodySchema>;
