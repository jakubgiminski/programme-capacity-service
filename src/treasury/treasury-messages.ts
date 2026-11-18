import { z } from 'zod';
import { identifierSchema } from '../capacity/domain/identifier';
import {
  currencySchema,
  moneySchema,
  nonNegativeMinorUnitsSchema,
  positiveMinorUnitsSchema,
} from '../money';

export const TreasuryMessageType = {
  ProgramLimitSet: 'ProgramLimitSet',
  InvoiceRepaid: 'InvoiceRepaid',
  ProgramSnapshot: 'ProgramSnapshot',
} as const;

const envelopeShape = {
  messageId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  programId: identifierSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  type: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
  occurredAt: z.iso.datetime({ offset: true }),
};

const envelopeSchema = z.object(envelopeShape);

const programLimitSetSchema = z.strictObject({
  ...envelopeShape,
  type: z.literal(TreasuryMessageType.ProgramLimitSet),
  currency: currencySchema,
  limit: nonNegativeMinorUnitsSchema,
});

const invoiceRepaidSchema = z.strictObject({
  ...envelopeShape,
  type: z.literal(TreasuryMessageType.InvoiceRepaid),
  invoiceId: identifierSchema,
  releaseId: identifierSchema,
  amount: moneySchema.optional(),
});

const snapshotReservationSchema = z
  .strictObject({
    invoiceId: identifierSchema,
    invoiceAmount: positiveMinorUnitsSchema,
    invoiceCurrency: currencySchema,
    outstandingInvoiceAmount: positiveMinorUnitsSchema,
    bookedAmount: nonNegativeMinorUnitsSchema,
  })
  .refine((entry) => entry.outstandingInvoiceAmount <= entry.invoiceAmount, {
    path: ['outstandingInvoiceAmount'],
    message: 'Outstanding invoice amount cannot exceed the invoice amount',
  });

const programSnapshotSchema = z
  .strictObject({
    ...envelopeShape,
    type: z.literal(TreasuryMessageType.ProgramSnapshot),
    currency: currencySchema,
    limit: nonNegativeMinorUnitsSchema,
    asOf: z.iso.datetime({ offset: true }),
    reservations: z.array(snapshotReservationSchema).max(100_000),
  })
  .superRefine((snapshot, context) => {
    const seen = new Set<string>();
    snapshot.reservations.forEach((reservation, index) => {
      if (seen.has(reservation.invoiceId)) {
        context.addIssue({
          code: 'custom',
          path: ['reservations', index, 'invoiceId'],
          message: `Duplicate invoiceId ${reservation.invoiceId}`,
        });
      }
      seen.add(reservation.invoiceId);
    });
  });

const treasuryMessageSchema = z.discriminatedUnion('type', [
  programLimitSetSchema,
  invoiceRepaidSchema,
  programSnapshotSchema,
]);

export type TreasuryEnvelope = z.output<typeof envelopeSchema>;
export type ProgramLimitSet = z.output<typeof programLimitSetSchema>;
export type InvoiceRepaid = z.output<typeof invoiceRepaidSchema>;
export type ProgramSnapshot = z.output<typeof programSnapshotSchema>;
export type TreasuryMessage = z.output<typeof treasuryMessageSchema>;

export type ParsedTreasuryMessage =
  | { readonly kind: 'unreadable'; readonly reason: string }
  | {
      readonly kind: 'readable';
      readonly envelope: TreasuryEnvelope;
      readonly message: TreasuryMessage | null;
      readonly error: string | null;
    };

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
    .replaceAll('\u0000', '\uFFFD')
    .slice(0, 2_000);
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

export function parseTreasuryMessage(raw: string): ParsedTreasuryMessage {
  const json = parseJson(raw);
  if (!json.ok) {
    return { kind: 'unreadable', reason: 'Message value is not valid JSON' };
  }
  const envelope = envelopeSchema.safeParse(json.value);
  if (!envelope.success) {
    return { kind: 'unreadable', reason: `Invalid envelope: ${describe(envelope.error)}` };
  }
  const message = treasuryMessageSchema.safeParse(json.value);
  if (!message.success) {
    return {
      kind: 'readable',
      envelope: envelope.data,
      message: null,
      error: `Invalid ${envelope.data.type} message: ${describe(message.error)}`,
    };
  }
  return { kind: 'readable', envelope: envelope.data, message: message.data, error: null };
}
