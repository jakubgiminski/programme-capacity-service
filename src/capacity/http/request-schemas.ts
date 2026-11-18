import { z } from 'zod';
import { moneySchema } from '../../money';
import { identifierSchema } from '../domain/identifier';
import { type DiscrepancyCursor } from '../infrastructure/treasury.repository';

const discrepancyKindSchema = z.enum([
  'TREASURY_AMOUNT_LOWER',
  'INVOICE_OUTSTANDING_LOWER',
  'MISSING_FROM_SNAPSHOT',
  'RELEASED_LOCALLY',
  'INVOICE_MISMATCH',
]);

const cursorSchema = z.tuple([identifierSchema, discrepancyKindSchema]);

export function encodeCursor(cursor: DiscrepancyCursor): string {
  return Buffer.from(JSON.stringify([cursor.invoiceId, cursor.kind]), 'utf8').toString('base64url');
}

function decodeCursor(value: string): DiscrepancyCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const parsed = cursorSchema.safeParse(decoded);
    return parsed.success ? { invoiceId: parsed.data[0], kind: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

export const reserveBodySchema = z.strictObject({
  invoiceId: identifierSchema,
  amount: moneySchema,
});

export const releaseBodySchema = z.strictObject({
  releaseId: identifierSchema,
  amount: moneySchema.optional(),
});

export const discrepancyQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  after: z
    .string()
    .max(256)
    .optional()
    .transform((value, context) => {
      if (value === undefined) {
        return null;
      }
      const cursor = decodeCursor(value);
      if (cursor === null) {
        context.addIssue({ code: 'custom', message: 'Invalid cursor' });
        return z.NEVER;
      }
      return cursor;
    }),
});

export type ReserveBody = z.output<typeof reserveBodySchema>;
export type ReleaseBody = z.output<typeof releaseBodySchema>;
export type DiscrepancyQuery = z.output<typeof discrepancyQuerySchema>;
