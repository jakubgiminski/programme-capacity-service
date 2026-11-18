import { z } from 'zod';
import { moneySchema } from '../../money';
import { identifierSchema } from '../domain/identifier';

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
