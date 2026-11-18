import { parseTreasuryMessage } from './treasury-messages';

const envelope = {
  messageId: 'msg-1',
  programId: 'PRG-1',
  revision: 3,
  occurredAt: '2026-11-18T10:00:00Z',
};

function raw(value: object): string {
  return JSON.stringify(value);
}

describe('parseTreasuryMessage', () => {
  it('parses a ProgramLimitSet message with amounts as bigint', () => {
    const parsed = parseTreasuryMessage(
      raw({ ...envelope, type: 'ProgramLimitSet', currency: 'USD', limit: '1000000000' }),
    );

    expect(parsed).toMatchObject({
      kind: 'readable',
      error: null,
      message: { type: 'ProgramLimitSet', currency: 'USD', limit: 1_000_000_000n },
    });
  });

  it('parses an InvoiceRepaid message with and without an amount', () => {
    const full = parseTreasuryMessage(
      raw({ ...envelope, type: 'InvoiceRepaid', invoiceId: 'INV-1', releaseId: 'R-1' }),
    );
    const partial = parseTreasuryMessage(
      raw({
        ...envelope,
        type: 'InvoiceRepaid',
        invoiceId: 'INV-1',
        releaseId: 'R-2',
        amount: { amount: '100', currency: 'EUR' },
      }),
    );

    expect(full).toMatchObject({ kind: 'readable', message: { releaseId: 'R-1' } });
    expect(partial).toMatchObject({
      kind: 'readable',
      message: { amount: { amount: 100n, currency: 'EUR' } },
    });
  });

  it('rejects unknown fields instead of dropping them', () => {
    const parsed = parseTreasuryMessage(
      raw({
        ...envelope,
        type: 'InvoiceRepaid',
        invoiceId: 'INV-1',
        releaseId: 'R-1',
        repaymentAmount: { amount: '100', currency: 'EUR' },
      }),
    );

    expect(parsed).toMatchObject({ kind: 'readable', message: null });
    expect(parsed.kind === 'readable' ? parsed.error : '').toContain('repaymentAmount');
  });

  it.each(['Program\\u0000Snapshot', 'program snapshot', '1Snapshot'])(
    'treats an envelope with type %j as unreadable',
    (type) => {
      const parsed = parseTreasuryMessage(
        `{"messageId":"msg-1","programId":"PRG-1","revision":3,"occurredAt":"2026-11-18T10:00:00Z","type":"${type}"}`,
      );

      expect(parsed.kind).toBe('unreadable');
    },
  );

  it('never puts NUL characters into rejection reasons', () => {
    const parsed = parseTreasuryMessage(
      `{"messageId":"msg-1","programId":"PRG-1","revision":3,"occurredAt":"2026-11-18T10:00:00Z","type":"ProgramLimitSet","currency":"USD","limit":"1","\\u0000":1}`,
    );

    expect(parsed).toMatchObject({ kind: 'readable', message: null });
    expect(parsed.kind === 'readable' ? parsed.error : '').not.toContain('\u0000');
  });

  it('parses a snapshot including an empty reservation list', () => {
    const parsed = parseTreasuryMessage(
      raw({
        ...envelope,
        type: 'ProgramSnapshot',
        currency: 'USD',
        limit: '0',
        asOf: '2026-11-18T09:00:00Z',
        reservations: [],
      }),
    );

    expect(parsed).toMatchObject({ kind: 'readable', error: null });
  });

  it.each([
    ['not json', '{'],
    ['an array', '[]'],
    ['a missing messageId', raw({ ...envelope, messageId: undefined, type: 'X' })],
    ['a non-integer revision', raw({ ...envelope, revision: 1.5, type: 'X' })],
    ['a zero revision', raw({ ...envelope, revision: 0, type: 'X' })],
    ['a string revision', raw({ ...envelope, revision: '3', type: 'X' })],
    ['an invalid programId', raw({ ...envelope, programId: 'bad id', type: 'X' })],
  ])('treats %s as unreadable', (_label, value) => {
    expect(parseTreasuryMessage(value).kind).toBe('unreadable');
  });

  it.each([
    ['an unknown type', { type: 'Mystery' }],
    ['a negative limit', { type: 'ProgramLimitSet', currency: 'USD', limit: '-1' }],
    ['a numeric limit', { type: 'ProgramLimitSet', currency: 'USD', limit: 100 }],
    ['an unknown currency', { type: 'ProgramLimitSet', currency: 'ABC', limit: '1' }],
    ['a repayment without releaseId', { type: 'InvoiceRepaid', invoiceId: 'INV-1' }],
    [
      'a snapshot with duplicate invoices',
      {
        type: 'ProgramSnapshot',
        currency: 'USD',
        limit: '100',
        asOf: '2026-11-18T09:00:00Z',
        reservations: [
          { invoiceId: 'A', invoiceAmount: '1', invoiceCurrency: 'USD', bookedAmount: '1' },
          { invoiceId: 'A', invoiceAmount: '2', invoiceCurrency: 'USD', bookedAmount: '2' },
        ],
      },
    ],
    [
      'a snapshot with a negative booked amount',
      {
        type: 'ProgramSnapshot',
        currency: 'USD',
        limit: '100',
        asOf: '2026-11-18T09:00:00Z',
        reservations: [
          { invoiceId: 'A', invoiceAmount: '1', invoiceCurrency: 'USD', bookedAmount: '-1' },
        ],
      },
    ],
  ])('keeps the envelope but reports %s as an invalid body', (_label, body) => {
    const parsed = parseTreasuryMessage(raw({ ...envelope, ...body }));

    expect(parsed).toMatchObject({
      kind: 'readable',
      message: null,
      envelope: { messageId: 'msg-1', revision: 3 },
    });
    expect(parsed.kind === 'readable' && parsed.error).toEqual(expect.any(String));
  });
});
