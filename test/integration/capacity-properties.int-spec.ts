import fc from 'fast-check';
import { CapacityError } from '../../src/capacity/domain/errors';
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
  | {
      kind: 'snapshot';
      limit: bigint;
      entries: { invoice: number; booked: bigint }[];
    };

const invoiceArb = fc.integer({ min: 0, max: 8 });

const operationArb: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({
    kind: fc.constant('reserve' as const),
    invoice: invoiceArb,
    amount: fc.bigInt({ min: 1n, max: 400_000n }),
    currency: fc.constantFrom(USD, EUR, JPY),
  }),
  fc.record({
    kind: fc.constant('release' as const),
    invoice: invoiceArb,
    releaseId: fc.integer({ min: 0, max: 3 }),
    amount: fc.option(fc.bigInt({ min: 1n, max: 200_000n }), { nil: null }),
  }),
  fc.record({
    kind: fc.constant('limit' as const),
    limit: fc.bigInt({ min: 0n, max: 2_000_000n }),
  }),
  fc.record({
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

  it('keeps balances consistent for any sequence of reservations, releases, limit changes and snapshots', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(operationArb, { minLength: 1, maxLength: 25 }),
        async (operations) => {
          run += 1;
          const programId = `PRG-P-${run}`;
          const stream = { revision: 1 };
          await services.treasury.execute(
            inbound(limitSet(`${programId}-1`, programId, 1, '1000000')),
          );

          for (const operation of operations) {
            const before = await programState(database.db, programId);
            const outcome = await apply(services, database.db, programId, operation, stream);
            const after = await programState(database.db, programId);

            if (outcome.status === 'rejected') {
              expect(outcome.error).toBeInstanceOf(CapacityError);
              expect(after).toEqual(before);
            }
            if (outcome.status === 'reserved') {
              expect(after.utilisedMinor - before.utilisedMinor).toBe(outcome.bookedMinor);
              expect(outcome.bookedMinor <= before.limitMinor - before.utilisedMinor).toBe(true);
            }
            if (outcome.status === 'replayed') {
              expect(after).toEqual(before);
            }
            await expectInvariants(database.db, programId);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

type Outcome =
  | { status: 'reserved'; bookedMinor: bigint }
  | { status: 'released' }
  | { status: 'replayed' }
  | { status: 'treasury' }
  | { status: 'rejected'; error: unknown };

async function apply(
  services: CapacityServices,
  db: Db,
  programId: string,
  operation: Operation,
  stream: { revision: number },
): Promise<Outcome> {
  if (operation.kind === 'limit' || operation.kind === 'snapshot') {
    stream.revision += 1;
    const messageId = `${programId}-${stream.revision}`;
    const message =
      operation.kind === 'limit'
        ? limitSet(messageId, programId, stream.revision, operation.limit.toString())
        : snapshot(
            messageId,
            programId,
            stream.revision,
            operation.limit.toString(),
            operation.entries.map((entry) => ({
              invoiceId: `INV-${entry.invoice}`,
              invoiceAmount: entry.booked.toString(),
              invoiceCurrency: 'USD',
              bookedAmount: entry.booked.toString(),
            })),
          );
    const result = await services.treasury.execute(inbound(message));
    expect(result.outcome).toBe('APPLIED');
    return { status: 'treasury' };
  }
  try {
    if (operation.kind === 'reserve') {
      const result = await services.reserve.execute({
        programId,
        invoiceId: `INV-${operation.invoice}`,
        invoiceAmount: money(operation.amount, operation.currency),
        actor: testActor,
      });
      return result.created
        ? { status: 'reserved', bookedMinor: result.reservation.bookedMinor }
        : { status: 'replayed' };
    }
    const reservation = await services.repository.findReservation(
      db,
      programId,
      `INV-${operation.invoice}`,
    );
    const result = await services.release.execute({
      programId,
      invoiceId: `INV-${operation.invoice}`,
      releaseId: `REL-${operation.releaseId}`,
      amount:
        operation.amount === null || reservation === null
          ? null
          : money(operation.amount, reservation.invoiceCurrency),
      actor: testActor,
    });
    return result.created ? { status: 'released' } : { status: 'replayed' };
  } catch (error) {
    return { status: 'rejected', error };
  }
}
