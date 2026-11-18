import fc from 'fast-check';
import {
  InsufficientCapacityError,
  InvoiceConflictError,
  OverReleaseError,
  ReleaseConflictError,
  ReservationAlreadyReleasedError,
  ReservationNotFoundError,
} from '../../src/capacity/domain/errors';
import { type Db } from '../../src/database/database';
import { type CurrencyCode } from '../../src/money';
import {
  buildCapacityServices,
  type CapacityServices,
  EUR,
  expectInvariants,
  FakeFxRateProvider,
  JPY,
  money,
  programState,
  testActor,
  USD,
} from '../support/capacity-fixture';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { inbound, limitSet, snapshot } from '../support/treasury-messages';

type Operation =
  | { kind: 'reserve'; invoice: number; amount: bigint; currency: CurrencyCode }
  | { kind: 'release'; invoice: number; releaseId: number; amount: bigint | null }
  | { kind: 'limit'; limit: bigint }
  | { kind: 'snapshot'; limit: bigint; entries: { invoice: number; booked: bigint }[] };

interface ModelReservation {
  currency: CurrencyCode;
  invoiceAmount: bigint;
  booked: bigint;
  released: bigint;
  invoiceReleased: bigint;
  baseInvoiceReleased: bigint;
  baseReleased: bigint;
  releases: Map<string, bigint | null>;
}

interface Model {
  limit: bigint;
  utilised: bigint;
  reservations: Map<string, ModelReservation>;
}

type Expected =
  | { outcome: 'reserved'; booked: bigint }
  | { outcome: 'released'; freed: bigint }
  | { outcome: 'replayed' }
  | { outcome: 'rejected'; error: new (...args: never[]) => Error };

const RATES: Record<string, { scaled: bigint; exponent: bigint }> = {
  USD: { scaled: 10_000_000_000n, exponent: 2n },
  EUR: { scaled: 10_853_000_000n, exponent: 2n },
  JPY: { scaled: 66_500_000n, exponent: 0n },
};

function expectedBooking(amount: bigint, currency: CurrencyCode): bigint {
  const rate = RATES[currency]!;
  const numerator = amount * rate.scaled * 100n;
  const denominator = 10_000_000_000n * 10n ** rate.exponent;
  return (numerator + denominator - 1n) / denominator;
}

function expectReserve(
  model: Model,
  invoiceId: string,
  amount: bigint,
  currency: CurrencyCode,
): Expected {
  const existing = model.reservations.get(invoiceId);
  if (existing !== undefined) {
    if (existing.invoiceAmount === amount && existing.currency === currency) {
      return { outcome: 'replayed' };
    }
    return { outcome: 'rejected', error: InvoiceConflictError };
  }
  const booked = expectedBooking(amount, currency);
  if (booked > model.limit - model.utilised) {
    return { outcome: 'rejected', error: InsufficientCapacityError };
  }
  model.reservations.set(invoiceId, {
    currency,
    invoiceAmount: amount,
    booked,
    released: 0n,
    invoiceReleased: 0n,
    baseInvoiceReleased: 0n,
    baseReleased: 0n,
    releases: new Map(),
  });
  model.utilised += booked;
  return { outcome: 'reserved', booked };
}

function expectRelease(
  model: Model,
  invoiceId: string,
  releaseId: string,
  amount: bigint | null,
): Expected {
  const reservation = model.reservations.get(invoiceId);
  if (reservation === undefined) {
    return { outcome: 'rejected', error: ReservationNotFoundError };
  }
  if (reservation.releases.has(releaseId)) {
    return reservation.releases.get(releaseId) === amount
      ? { outcome: 'replayed' }
      : { outcome: 'rejected', error: ReleaseConflictError };
  }
  if (reservation.invoiceReleased === reservation.invoiceAmount) {
    return { outcome: 'rejected', error: ReservationAlreadyReleasedError };
  }
  const outstandingInvoice = reservation.invoiceAmount - reservation.invoiceReleased;
  const slice = amount ?? outstandingInvoice;
  if (slice > outstandingInvoice) {
    return { outcome: 'rejected', error: OverReleaseError };
  }
  const cumulative = reservation.invoiceReleased + slice;
  const target = cumulativeFreed(reservation, cumulative);
  const freed = target - reservation.released;
  reservation.released = target;
  reservation.invoiceReleased = cumulative;
  reservation.releases.set(releaseId, amount);
  model.utilised -= freed;
  return { outcome: 'released', freed };
}

function cumulativeFreed(reservation: ModelReservation, cumulativeInvoice: bigint): bigint {
  if (cumulativeInvoice === reservation.invoiceAmount) {
    return reservation.booked;
  }
  const share =
    reservation.baseReleased +
    ((reservation.booked - reservation.baseReleased) *
      (cumulativeInvoice - reservation.baseInvoiceReleased)) /
      (reservation.invoiceAmount - reservation.baseInvoiceReleased);
  if (share < reservation.released) {
    return reservation.released;
  }
  return share;
}

async function resyncFromDatabase(db: Db, programId: string, model: Model): Promise<void> {
  const program = await db
    .selectFrom('programs')
    .select(['limit_minor', 'utilised_minor'])
    .where('id', '=', programId)
    .executeTakeFirstOrThrow();
  model.limit = program.limit_minor;
  model.utilised = program.utilised_minor;
  const rows = await db
    .selectFrom('reservations')
    .selectAll()
    .where('program_id', '=', programId)
    .execute();
  for (const row of rows) {
    const known = model.reservations.get(row.invoice_id);
    model.reservations.set(row.invoice_id, {
      currency: row.invoice_currency as CurrencyCode,
      invoiceAmount: row.invoice_amount_minor,
      booked: row.booked_minor,
      released: row.released_minor,
      invoiceReleased: row.invoice_released_minor,
      baseInvoiceReleased: row.allocation_base_invoice_minor,
      baseReleased: row.allocation_base_released_minor,
      releases: known?.releases ?? new Map(),
    });
  }
}

const invoiceArb = fc.integer({ min: 0, max: 8 });

const operationArb: fc.Arbitrary<Operation> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('reserve' as const),
      invoice: invoiceArb,
      amount: fc.bigInt({ min: 1n, max: 400_000n }),
      currency: fc.constantFrom(USD, EUR, JPY),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('release' as const),
      invoice: invoiceArb,
      releaseId: fc.integer({ min: 0, max: 3 }),
      amount: fc.option(fc.bigInt({ min: 1n, max: 200_000n }), { nil: null }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('limit' as const),
      limit: fc.bigInt({ min: 0n, max: 2_000_000n }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('snapshot' as const),
      limit: fc.bigInt({ min: 0n, max: 2_000_000n }),
      entries: fc.uniqueArray(
        fc.record({
          invoice: fc.integer({ min: 0, max: 8 }),
          booked: fc.bigInt({ min: 1n, max: 300_000n }),
        }),
        { selector: (entry) => entry.invoice, maxLength: 6 },
      ),
    }),
  },
);

describe('capacity properties (Postgres)', () => {
  let database: TestDatabase;
  let services: CapacityServices;
  let run = 0;

  beforeAll(async () => {
    database = await createTestDatabase();
    services = buildCapacityServices(
      database.db,
      new FakeFxRateProvider().set(EUR, USD, '1.0853').set(JPY, USD, '0.00665'),
    );
  });

  afterAll(async () => {
    await database.destroy();
  });

  it('matches a reference model for any sequence of reservations, releases, limit changes and snapshots', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(operationArb, { minLength: 1, maxLength: 25 }),
        async (operations) => {
          run += 1;
          const programId = `PRG-P-${run}`;
          let revision = 1;
          await services.treasury.execute(
            inbound(limitSet(`${programId}-1`, programId, 1, '1000000')),
          );
          const model: Model = { limit: 1_000_000n, utilised: 0n, reservations: new Map() };

          for (const operation of operations) {
            const before = await programState(database.db, programId);

            if (operation.kind === 'limit' || operation.kind === 'snapshot') {
              revision += 1;
              const messageId = `${programId}-${revision}`;
              const message =
                operation.kind === 'limit'
                  ? limitSet(messageId, programId, revision, operation.limit.toString())
                  : snapshot(
                      messageId,
                      programId,
                      revision,
                      operation.limit.toString(),
                      operation.entries.map((entry) => {
                        const local = model.reservations.get(`INV-${entry.invoice}`);
                        return {
                          invoiceId: `INV-${entry.invoice}`,
                          invoiceAmount: (local?.invoiceAmount ?? entry.booked).toString(),
                          invoiceCurrency: local?.currency ?? 'USD',
                          bookedAmount: entry.booked.toString(),
                        };
                      }),
                    );
              const result = await services.treasury.execute(inbound(message));
              expect(result.outcome).toBe('APPLIED');
              await resyncFromDatabase(database.db, programId, model);
              await expectInvariants(database.db, programId);
              continue;
            }

            const invoiceId = `INV-${operation.invoice}`;
            if (operation.kind === 'reserve') {
              const expected = expectReserve(
                model,
                invoiceId,
                operation.amount,
                operation.currency,
              );
              const actual = await services.reserve
                .execute({
                  programId,
                  invoiceId,
                  invoiceAmount: money(operation.amount, operation.currency),
                  actor: testActor,
                })
                .then(
                  (result) => ({ ok: true as const, result }),
                  (error: unknown) => ({ ok: false as const, error }),
                );
              if (expected.outcome === 'rejected') {
                expect(actual.ok ? 'accepted' : actual.error).toBeInstanceOf(expected.error);
                expect(await programState(database.db, programId)).toEqual(before);
              }
              if (expected.outcome === 'reserved') {
                expect(actual.ok && actual.result.created).toBe(true);
                expect(actual.ok && actual.result.reservation.bookedMinor).toBe(expected.booked);
                expect(expected.booked <= before.limitMinor - before.utilisedMinor).toBe(true);
              }
              if (expected.outcome === 'replayed') {
                expect(actual.ok && !actual.result.created).toBe(true);
                expect(await programState(database.db, programId)).toEqual(before);
              }
            }

            if (operation.kind === 'release') {
              const releaseId = `REL-${operation.releaseId}`;
              const expected = expectRelease(model, invoiceId, releaseId, operation.amount);
              const currency = model.reservations.get(invoiceId)?.currency ?? USD;
              const actual = await services.release
                .execute({
                  programId,
                  invoiceId,
                  releaseId,
                  amount: operation.amount === null ? null : money(operation.amount, currency),
                  actor: testActor,
                })
                .then(
                  (result) => ({ ok: true as const, result }),
                  (error: unknown) => ({ ok: false as const, error }),
                );
              if (expected.outcome === 'rejected') {
                expect(actual.ok ? 'accepted' : actual.error).toBeInstanceOf(expected.error);
                expect(await programState(database.db, programId)).toEqual(before);
              }
              if (expected.outcome === 'released') {
                expect(actual.ok && actual.result.created).toBe(true);
                expect(actual.ok && actual.result.release.freedMinor).toBe(expected.freed);
              }
              if (expected.outcome === 'replayed') {
                expect(actual.ok && !actual.result.created).toBe(true);
                expect(await programState(database.db, programId)).toEqual(before);
              }
            }

            const after = await programState(database.db, programId);
            expect(after.utilisedMinor).toBe(model.utilised);
            expect(after.limitMinor).toBe(model.limit);
            await expectInvariants(database.db, programId);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
