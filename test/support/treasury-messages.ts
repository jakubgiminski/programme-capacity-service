import { type InboundTreasuryMessage } from '../../src/capacity/application/apply-treasury-message';
import { parseTreasuryMessage } from '../../src/treasury/treasury-messages';

let offset = 0;

export interface SnapshotEntry {
  invoiceId: string;
  invoiceAmount: string;
  invoiceCurrency: string;
  outstandingInvoiceAmount?: string;
  bookedAmount: string;
}

export function limitSet(
  messageId: string,
  programId: string,
  revision: number,
  limit: string,
  currency = 'USD',
): Record<string, unknown> {
  return {
    messageId,
    programId,
    revision,
    type: 'ProgramLimitSet',
    occurredAt: '2026-11-18T10:00:00Z',
    currency,
    limit,
  };
}

export function invoiceRepaid(
  messageId: string,
  programId: string,
  revision: number,
  invoiceId: string,
  releaseId: string,
  amount?: { amount: string; currency: string },
): Record<string, unknown> {
  return {
    messageId,
    programId,
    revision,
    type: 'InvoiceRepaid',
    occurredAt: '2026-11-18T10:00:00Z',
    invoiceId,
    releaseId,
    ...(amount === undefined ? {} : { amount }),
  };
}

export function snapshot(
  messageId: string,
  programId: string,
  revision: number,
  limit: string,
  reservations: SnapshotEntry[],
  currency = 'USD',
): Record<string, unknown> {
  return {
    messageId,
    programId,
    revision,
    type: 'ProgramSnapshot',
    occurredAt: '2026-11-18T10:00:00Z',
    asOf: '2026-11-18T09:59:00Z',
    currency,
    limit,
    reservations: reservations.map((entry) => ({
      ...entry,
      outstandingInvoiceAmount: entry.outstandingInvoiceAmount ?? entry.invoiceAmount,
    })),
  };
}

export function inbound(message: Record<string, unknown> | string): InboundTreasuryMessage {
  const rawValue = typeof message === 'string' ? message : JSON.stringify(message);
  const parsed = parseTreasuryMessage(rawValue);
  if (parsed.kind === 'unreadable') {
    throw new Error(`Test message is unreadable: ${parsed.reason}`);
  }
  offset += 1;
  return {
    parsed,
    rawValue,
    source: { topic: 'treasury.test', partition: 0, offset: String(offset) },
  };
}
