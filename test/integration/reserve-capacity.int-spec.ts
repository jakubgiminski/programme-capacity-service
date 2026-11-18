import { sql } from 'kysely';
import {
  FxRateUnavailableError,
  InsufficientCapacityError,
  InvoiceConflictError,
  ProgramNotFoundError,
} from '../../src/capacity/domain/errors';
import {
  buildCapacityServices,
  type CapacityServices,
  createProgram,
  EUR,
  expectInvariants,
  FakeFxRateProvider,
  GBP,
  JPY,
  KWD,
  money,
  programState,
  testActor,
  USD,
} from '../support/capacity-fixture';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

describe('ReserveCapacity (Postgres)', () => {
  let database: TestDatabase;
  let fx: FakeFxRateProvider;
  let services: CapacityServices;
  let sequence = 0;

  function programId(): string {
    sequence += 1;
    return `PRG-R-${sequence}`;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.destroy();
  });

  beforeEach(() => {
    fx = new FakeFxRateProvider().set(EUR, USD, '1.085').set(JPY, KWD, '0.0020445');
    services = buildCapacityServices(database.db, fx);
  });

  it('books the converted amount rounded up and writes an audit entry', async () => {
    const id = programId();
    await createProgram(database.db, id, USD, 1_000_000n);

    const result = await services.reserve.execute({
      programId: id,
      invoiceId: 'INV-1',
      invoiceAmount: money(100_001n, EUR),
      actor: testActor,
    });

    expect(result.created).toBe(true);
    expect(result.reservation).toMatchObject({
      status: 'ACTIVE',
      origin: 'API',
      invoiceAmountMinor: 100_001n,
      invoiceCurrency: EUR,
      bookedMinor: 108_502n,
      releasedMinor: 0n,
      fx: { rateScaled: 10_850_000_000n, scale: 10, source: 'fake' },
    });
    const capacity = await services.queries.getCapacity(id);
    expect(capacity.program.utilisedMinor).toBe(108_502n);
    expect(capacity.availableMinor).toBe(891_498n);
    expect(capacity.program.version).toBe(1n);

    const ledger = await database.db
      .selectFrom('ledger_entries')
      .selectAll()
      .where('program_id', '=', id)
      .execute();
    expect(ledger).toEqual([
      expect.objectContaining({
        type: 'RESERVE',
        reservation_id: result.reservation.id,
        delta_minor: 108_502n,
        utilised_after_minor: 108_502n,
        limit_after_minor: 1_000_000n,
        actor: 'test-client',
        correlation_id: 'corr-1',
      }),
    ]);
    await expectInvariants(database.db, id);
  });

  it('converts across currencies with different exponents', async () => {
    const id = programId();
    await createProgram(database.db, id, KWD, 10_000_000n);

    const result = await services.reserve.execute({
      programId: id,
      invoiceId: 'INV-JPY',
      invoiceAmount: money(1_000_001n, JPY),
      actor: testActor,
    });

    expect(result.reservation.bookedMinor).toBe(2_044_503n);
  });

  it('returns the original reservation on an identical retry without touching balances', async () => {
    const id = programId();
    await createProgram(database.db, id, USD, 1_000_000n);
    const command = {
      programId: id,
      invoiceId: 'INV-1',
      invoiceAmount: money(10_000n, EUR),
      actor: testActor,
    };
    const first = await services.reserve.execute(command);
    const before = await programState(database.db, id);

    const retry = await services.reserve.execute(command);

    expect(retry.created).toBe(false);
    expect(retry.reservation).toEqual(first.reservation);
    expect(await programState(database.db, id)).toEqual(before);
  });

  it('keeps the locked FX rate on retries after the rate changed or disappeared', async () => {
    const id = programId();
    await createProgram(database.db, id, USD, 1_000_000n);
    const command = {
      programId: id,
      invoiceId: 'INV-1',
      invoiceAmount: money(10_000n, EUR),
      actor: testActor,
    };
    const first = await services.reserve.execute(command);
    fx.set(EUR, USD, '2.5');

    const afterChange = await services.reserve.execute(command);
    fx.remove(EUR, USD);
    const afterRemoval = await services.reserve.execute(command);

    expect(first.reservation.bookedMinor).toBe(10_850n);
    expect(afterChange.reservation.bookedMinor).toBe(10_850n);
    expect(afterRemoval.reservation.bookedMinor).toBe(10_850n);
    expect(afterRemoval.created).toBe(false);
  });

  it('rejects the same invoice with a different amount or currency', async () => {
    const id = programId();
    await createProgram(database.db, id, USD, 1_000_000n);
    await services.reserve.execute({
      programId: id,
      invoiceId: 'INV-1',
      invoiceAmount: money(10_000n, EUR),
      actor: testActor,
    });
    const before = await programState(database.db, id);

    await expect(
      services.reserve.execute({
        programId: id,
        invoiceId: 'INV-1',
        invoiceAmount: money(10_001n, EUR),
        actor: testActor,
      }),
    ).rejects.toBeInstanceOf(InvoiceConflictError);
    await expect(
      services.reserve.execute({
        programId: id,
        invoiceId: 'INV-1',
        invoiceAmount: money(10_000n, USD),
        actor: testActor,
      }),
    ).rejects.toBeInstanceOf(InvoiceConflictError);
    expect(await programState(database.db, id)).toEqual(before);
  });

  it('rejects a reservation that exceeds available capacity without writing anything', async () => {
    const id = programId();
    await createProgram(database.db, id, USD, 10_000n);
    const before = await programState(database.db, id);

    await expect(
      services.reserve.execute({
        programId: id,
        invoiceId: 'INV-1',
        invoiceAmount: money(10_001n, USD),
        actor: testActor,
      }),
    ).rejects.toMatchObject({ code: 'insufficient-capacity', availableMinor: 10_000n });
    expect(await programState(database.db, id)).toEqual(before);
  });

  it('fails with a missing FX pair before writing anything', async () => {
    const id = programId();
    await createProgram(database.db, id, USD, 10_000n);

    await expect(
      services.reserve.execute({
        programId: id,
        invoiceId: 'INV-1',
        invoiceAmount: money(1n, GBP),
        actor: testActor,
      }),
    ).rejects.toBeInstanceOf(FxRateUnavailableError);
    expect((await programState(database.db, id)).reservations).toBe(0);
  });

  it('rejects an unknown programme', async () => {
    await expect(
      services.reserve.execute({
        programId: 'PRG-MISSING',
        invoiceId: 'INV-1',
        invoiceAmount: money(1n, USD),
        actor: testActor,
      }),
    ).rejects.toBeInstanceOf(ProgramNotFoundError);
  });

  it('lets exactly N-1 of N parallel reservations through when the limit fits N-1', async () => {
    const id = programId();
    const parallel = 20;
    await createProgram(database.db, id, USD, BigInt(parallel - 1) * 1_000n);

    const results = await Promise.allSettled(
      Array.from({ length: parallel }, (_, index) =>
        services.reserve.execute({
          programId: id,
          invoiceId: `INV-${index}`,
          invoiceAmount: money(1_000n, USD),
          actor: testActor,
        }),
      ),
    );

    const rejected = results.filter((result) => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(parallel - 1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(InsufficientCapacityError);
    const capacity = await services.queries.getCapacity(id);
    expect(capacity.availableMinor).toBe(0n);
    expect(capacity.program.version).toBe(BigInt(parallel - 1));
    await expectInvariants(database.db, id);
  });

  it('creates exactly one reservation when the same invoice is submitted concurrently', async () => {
    const id = programId();
    await createProgram(database.db, id, USD, 1_000_000n);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        services.reserve.execute({
          programId: id,
          invoiceId: 'INV-SAME',
          invoiceAmount: money(5_000n, EUR),
          actor: testActor,
        }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.reservation.id)).size).toBe(1);
    expect((await services.queries.getCapacity(id)).program.utilisedMinor).toBe(5_425n);
    await expectInvariants(database.db, id);
  });

  it('enforces programme currency immutability and an append-only ledger in the database', async () => {
    const id = programId();
    await createProgram(database.db, id, USD, 1_000n);
    await services.reserve.execute({
      programId: id,
      invoiceId: 'INV-1',
      invoiceAmount: money(1n, USD),
      actor: testActor,
    });

    await expect(
      sql`UPDATE programs SET currency = 'EUR' WHERE id = ${id}`.execute(database.db),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql`UPDATE ledger_entries SET delta_minor = 0 WHERE program_id = ${id}`.execute(database.db),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql`DELETE FROM ledger_entries WHERE program_id = ${id}`.execute(database.db),
    ).rejects.toThrow(/append-only/);
  });
});
