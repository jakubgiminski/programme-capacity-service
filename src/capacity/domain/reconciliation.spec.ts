import { INT64_MAX, parseCurrency } from '../../money';
import { AmountOutOfRangeCapacityError } from './errors';
import { type Program, type Reservation, ZERO_ALLOCATION_BASE } from './model';
import { planReconciliation, type SnapshotReservation } from './reconciliation';

const USD = parseCurrency('USD');
const EUR = parseCurrency('EUR');

function program(overrides: Partial<Program> = {}): Program {
  return {
    id: 'PRG-1',
    currency: USD,
    limitMinor: 10_000n,
    utilisedMinor: 0n,
    version: 3n,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function reservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: `id-${overrides.invoiceId ?? 'INV-1'}`,
    programId: 'PRG-1',
    invoiceId: 'INV-1',
    status: 'ACTIVE',
    origin: 'API',
    invoiceAmountMinor: 1_000n,
    invoiceCurrency: EUR,
    invoiceReleasedMinor: 0n,
    bookedMinor: 1_100n,
    releasedMinor: 0n,
    allocationBase: ZERO_ALLOCATION_BASE,
    fx: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function entry(overrides: Partial<SnapshotReservation> = {}): SnapshotReservation {
  return {
    invoiceId: 'INV-1',
    invoiceAmountMinor: 1_000n,
    invoiceCurrency: EUR,
    outstandingInvoiceMinor: 1_000n,
    bookedMinor: 1_100n,
    ...overrides,
  };
}

function utilised(local: Reservation[]): bigint {
  return local
    .filter((item) => item.status !== 'RELEASED')
    .reduce((sum, item) => sum + item.bookedMinor - item.releasedMinor, 0n);
}

function plan(local: Reservation[], entries: SnapshotReservation[], limitMinor = 10_000n) {
  return planReconciliation(program({ utilisedMinor: utilised(local) }), local, {
    limitMinor,
    reservations: entries,
  });
}

describe('planReconciliation (fail-safe merge)', () => {
  it('applies a new limit even when it leaves the programme over-utilised', () => {
    const local = [reservation({ bookedMinor: 5_000n })];

    const result = plan(local, [entry({ bookedMinor: 5_000n })], 1_000n);

    expect(result.limitMinor).toBe(1_000n);
    expect(result.utilisedAfterMinor).toBe(5_000n);
    expect(result.changes).toEqual([]);
    expect(result.discrepancies).toEqual([]);
  });

  it('imports an invoice unknown locally with the treasury booked amount', () => {
    const result = plan([], [entry({ invoiceId: 'INV-T', bookedMinor: 777n })]);

    expect(result.changes).toEqual([
      {
        kind: 'import',
        entry: entry({ invoiceId: 'INV-T', bookedMinor: 777n }),
        invoiceReleasedMinor: 0n,
        status: 'ACTIVE',
        deltaMinor: 777n,
        reason: 'IMPORTED_FROM_SNAPSHOT',
      },
    ]);
    expect(result.utilisedAfterMinor).toBe(777n);
  });

  it('imports a partially repaid invoice with the repayments treasury reports', () => {
    const result = plan(
      [],
      [entry({ invoiceId: 'INV-T', outstandingInvoiceMinor: 600n, bookedMinor: 660n })],
    );

    expect(result.changes).toEqual([
      expect.objectContaining({
        kind: 'import',
        invoiceReleasedMinor: 400n,
        status: 'PARTIALLY_RELEASED',
        deltaMinor: 660n,
      }),
    ]);
  });

  it('adopts repayments treasury has seen for a TREASURY reservation', () => {
    const result = plan(
      [reservation({ origin: 'TREASURY', bookedMinor: 1_000n })],
      [entry({ outstandingInvoiceMinor: 600n, bookedMinor: 600n })],
    );

    expect(result.changes).toEqual([
      expect.objectContaining({
        status: 'PARTIALLY_RELEASED',
        invoiceReleasedAfterMinor: 400n,
        bookedAfterMinor: 600n,
        releasedAfterMinor: 0n,
        allocationBase: { invoiceReleasedMinor: 400n, releasedMinor: 0n },
        deltaMinor: -400n,
        reason: 'TREASURY_AMOUNT_LOWER',
      }),
    ]);
    expect(result.discrepancies).toEqual([]);
  });

  it('records adopted repayments even when the booked amount is unchanged', () => {
    const result = plan(
      [reservation({ origin: 'TREASURY', bookedMinor: 600n })],
      [entry({ outstandingInvoiceMinor: 600n, bookedMinor: 600n })],
    );

    expect(result.changes).toEqual([
      expect.objectContaining({
        invoiceReleasedAfterMinor: 400n,
        bookedAfterMinor: 600n,
        deltaMinor: 0n,
        reason: 'TREASURY_INVOICE_REPAID',
      }),
    ]);
  });

  it('never moves repayments backwards when treasury reports more outstanding', () => {
    const local = [
      reservation({
        origin: 'TREASURY',
        status: 'PARTIALLY_RELEASED',
        invoiceReleasedMinor: 500n,
        releasedMinor: 550n,
      }),
    ];

    const result = plan(local, [entry({ outstandingInvoiceMinor: 1_000n, bookedMinor: 550n })]);

    expect(result.changes).toEqual([]);
    expect(result.discrepancies).toEqual([]);
  });

  it('keeps local repayments for an API reservation and records a discrepancy', () => {
    const result = plan(
      [reservation({ origin: 'API' })],
      [entry({ outstandingInvoiceMinor: 600n, bookedMinor: 1_100n })],
    );

    expect(result.changes).toEqual([]);
    expect(result.discrepancies).toEqual([
      expect.objectContaining({ kind: 'INVOICE_OUTSTANDING_LOWER', localOutstandingMinor: 1_100n }),
    ]);
  });

  it('ignores outstanding invoice amounts in a different currency', () => {
    const result = plan(
      [reservation({ origin: 'TREASURY' })],
      [entry({ invoiceCurrency: USD, outstandingInvoiceMinor: 1n })],
    );

    expect(result.changes).toEqual([]);
    expect(result.discrepancies).toEqual([expect.objectContaining({ kind: 'INVOICE_MISMATCH' })]);
  });

  it.each(['API', 'TREASURY'] as const)(
    'applies a higher treasury booked amount for %s reservations',
    (origin) => {
      const result = plan([reservation({ origin })], [entry({ bookedMinor: 1_500n })]);

      expect(result.changes).toEqual([
        expect.objectContaining({
          kind: 'adjust',
          bookedAfterMinor: 1_500n,
          deltaMinor: 400n,
          reason: 'TREASURY_AMOUNT_HIGHER',
        }),
      ]);
      expect(result.utilisedAfterMinor).toBe(1_500n);
      expect(result.discrepancies).toEqual([]);
    },
  );

  it('compares outstanding amounts for partially released reservations', () => {
    const local = [
      reservation({
        status: 'PARTIALLY_RELEASED',
        invoiceReleasedMinor: 500n,
        releasedMinor: 550n,
      }),
    ];

    const same = plan(local, [entry({ bookedMinor: 550n })]);
    const higher = plan(local, [entry({ bookedMinor: 600n })]);

    expect(same.changes).toEqual([]);
    expect(higher.changes).toEqual([
      expect.objectContaining({
        bookedAfterMinor: 1_150n,
        releasedAfterMinor: 550n,
        deltaMinor: 50n,
      }),
    ]);
  });

  it('applies a lower treasury booked amount for TREASURY reservations', () => {
    const result = plan([reservation({ origin: 'TREASURY' })], [entry({ bookedMinor: 600n })]);

    expect(result.changes).toEqual([
      expect.objectContaining({
        bookedAfterMinor: 600n,
        status: 'ACTIVE',
        deltaMinor: -500n,
        reason: 'TREASURY_AMOUNT_LOWER',
      }),
    ]);
    expect(result.utilisedAfterMinor).toBe(600n);
  });

  it('keeps a lower treasury amount for API reservations and records a discrepancy', () => {
    const result = plan([reservation({ origin: 'API' })], [entry({ bookedMinor: 600n })]);

    expect(result.changes).toEqual([]);
    expect(result.utilisedAfterMinor).toBe(1_100n);
    expect(result.discrepancies).toEqual([
      expect.objectContaining({
        invoiceId: 'INV-1',
        kind: 'TREASURY_AMOUNT_LOWER',
        localOutstandingMinor: 1_100n,
        treasuryOutstandingMinor: 600n,
      }),
    ]);
  });

  it('releases a TREASURY reservation missing from the snapshot', () => {
    const local = [
      reservation({
        origin: 'TREASURY',
        status: 'PARTIALLY_RELEASED',
        invoiceReleasedMinor: 100n,
        releasedMinor: 110n,
      }),
    ];

    const result = plan(local, []);

    expect(result.changes).toEqual([
      expect.objectContaining({
        status: 'RELEASED',
        releasedAfterMinor: 1_100n,
        invoiceReleasedAfterMinor: 1_000n,
        deltaMinor: -990n,
        reason: 'MISSING_FROM_SNAPSHOT',
      }),
    ]);
    expect(result.utilisedAfterMinor).toBe(0n);
  });

  it('keeps an API reservation missing from the snapshot and records a discrepancy', () => {
    const result = plan([reservation({ origin: 'API' })], []);

    expect(result.changes).toEqual([]);
    expect(result.utilisedAfterMinor).toBe(1_100n);
    expect(result.discrepancies).toEqual([
      expect.objectContaining({ kind: 'MISSING_FROM_SNAPSHOT', treasuryOutstandingMinor: null }),
    ]);
  });

  it('keeps a locally released reservation released when treasury says it is active', () => {
    const local = [
      reservation({ status: 'RELEASED', invoiceReleasedMinor: 1_000n, releasedMinor: 1_100n }),
    ];

    const result = plan(local, [entry()]);

    expect(result.changes).toEqual([]);
    expect(result.utilisedAfterMinor).toBe(0n);
    expect(result.discrepancies).toEqual([
      expect.objectContaining({
        kind: 'RELEASED_LOCALLY',
        localStatus: 'RELEASED',
        localOutstandingMinor: 0n,
        treasuryOutstandingMinor: 1_100n,
      }),
    ]);
  });

  it('ignores locally released reservations that are absent from the snapshot', () => {
    const local = [
      reservation({ status: 'RELEASED', invoiceReleasedMinor: 1_000n, releasedMinor: 1_100n }),
    ];

    const result = plan(local, []);

    expect(result.changes).toEqual([]);
    expect(result.discrepancies).toEqual([]);
  });

  it('treats an empty snapshot as valid and applies the same rules', () => {
    const local = [
      reservation({ invoiceId: 'INV-API', origin: 'API' }),
      reservation({ invoiceId: 'INV-TRE', origin: 'TREASURY', bookedMinor: 300n }),
    ];

    const result = plan(local, [], 0n);

    expect(result.limitMinor).toBe(0n);
    expect(result.utilisedAfterMinor).toBe(1_100n);
    expect(result.changes).toEqual([
      expect.objectContaining({ reason: 'MISSING_FROM_SNAPSHOT', deltaMinor: -300n }),
    ]);
    expect(result.discrepancies).toEqual([
      expect.objectContaining({ invoiceId: 'INV-API', kind: 'MISSING_FROM_SNAPSHOT' }),
    ]);
  });

  it('flags invoice detail mismatches without blocking fail-safe amount changes', () => {
    const result = plan(
      [reservation()],
      [entry({ invoiceAmountMinor: 999n, invoiceCurrency: USD, bookedMinor: 1_200n })],
    );

    expect(result.discrepancies).toEqual([expect.objectContaining({ kind: 'INVOICE_MISMATCH' })]);
    expect(result.changes).toEqual([expect.objectContaining({ deltaMinor: 100n })]);
  });

  it('never reduces utilisation for API reservations, whatever the snapshot says', () => {
    const local = [
      reservation({ invoiceId: 'A', bookedMinor: 1_000n }),
      reservation({ invoiceId: 'B', bookedMinor: 2_000n }),
    ];

    const result = plan(local, [entry({ invoiceId: 'A', bookedMinor: 1n })]);

    expect(result.utilisedAfterMinor).toBe(3_000n);
    expect(result.changes.every((change) => change.deltaMinor >= 0n)).toBe(true);
  });

  it('orders changes and discrepancies by invoice id', () => {
    const result = plan(
      [reservation({ invoiceId: 'B' }), reservation({ invoiceId: 'D' })],
      [entry({ invoiceId: 'C' }), entry({ invoiceId: 'A' })],
    );

    expect(
      result.changes.map((change) => (change.kind === 'import' ? change.entry.invoiceId : '')),
    ).toEqual(['A', 'C']);
    expect(result.discrepancies.map((item) => item.invoiceId)).toEqual(['B', 'D']);
  });

  it('applies utilisation decreases before increases so no intermediate total overflows', () => {
    const result = planReconciliation(
      program({ limitMinor: INT64_MAX, utilisedMinor: INT64_MAX }),
      [reservation({ invoiceId: 'Z', origin: 'TREASURY', bookedMinor: INT64_MAX })],
      {
        limitMinor: INT64_MAX,
        reservations: [
          entry({ invoiceId: 'A', bookedMinor: 1n }),
          entry({ invoiceId: 'Z', invoiceAmountMinor: 1_000n, bookedMinor: INT64_MAX - 1n }),
        ],
      },
    );

    expect(result.changes.map((change) => change.deltaMinor)).toEqual([-1n, 1n]);
    expect(result.utilisedAfterMinor).toBe(INT64_MAX);
  });

  it('starts a new allocation base when it rebooks a partially released reservation', () => {
    const result = plan(
      [
        reservation({
          origin: 'TREASURY',
          status: 'PARTIALLY_RELEASED',
          invoiceReleasedMinor: 500n,
          releasedMinor: 550n,
        }),
      ],
      [entry({ bookedMinor: 1_000n })],
    );

    expect(result.changes).toEqual([
      expect.objectContaining({
        bookedAfterMinor: 1_550n,
        allocationBase: { invoiceReleasedMinor: 500n, releasedMinor: 550n },
      }),
    ]);
  });

  it('rejects a snapshot that would overflow BIGINT utilisation', () => {
    expect(() =>
      plan(
        [],
        [
          entry({ invoiceId: 'A', bookedMinor: INT64_MAX }),
          entry({ invoiceId: 'B', bookedMinor: 1n }),
        ],
      ),
    ).toThrow(AmountOutOfRangeCapacityError);
  });
});
