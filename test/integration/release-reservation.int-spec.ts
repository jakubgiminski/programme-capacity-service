import {
  OverReleaseError,
  ProgramNotFoundError,
  ReleaseConflictError,
  ReleaseCurrencyMismatchError,
  ReservationAlreadyReleasedError,
  ReservationNotFoundError,
} from '../../src/capacity/domain/errors';
import {
  buildCapacityServices,
  type CapacityServices,
  createProgram,
  EUR,
  expectInvariants,
  FakeFxRateProvider,
  money,
  programState,
  testActor,
  USD,
} from '../support/capacity-fixture';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

describe('ReleaseReservation (Postgres)', () => {
  let database: TestDatabase;
  let services: CapacityServices;
  let sequence = 0;

  async function programWithReservation(invoiceAmountMinor = 3n): Promise<string> {
    sequence += 1;
    const id = `PRG-L-${sequence}`;
    await createProgram(database.db, id, USD, 1_000_000n);
    await services.reserve.execute({
      programId: id,
      invoiceId: 'INV-1',
      invoiceAmount: money(invoiceAmountMinor, EUR),
      actor: testActor,
    });
    return id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    services = buildCapacityServices(database.db, new FakeFxRateProvider().set(EUR, USD, '333.34'));
  });

  afterAll(async () => {
    await database.destroy();
  });

  it('releases the full outstanding amount when no amount is given', async () => {
    const id = await programWithReservation();

    const result = await services.release.execute({
      programId: id,
      invoiceId: 'INV-1',
      releaseId: 'REL-1',
      amount: null,
      actor: testActor,
    });

    expect(result.created).toBe(true);
    expect(result.release).toMatchObject({
      invoiceAmountMinor: 3n,
      freedMinor: 1_001n,
      requestedInvoiceAmountMinor: null,
    });
    expect(result.reservation).toMatchObject({ status: 'RELEASED', releasedMinor: 1_001n });
    expect((await services.queries.getCapacity(id)).program.utilisedMinor).toBe(0n);
    await expectInvariants(database.db, id);
  });

  it('frees proportional shares rounded down and the remainder on the final release', async () => {
    const id = await programWithReservation();
    const release = (releaseId: string) =>
      services.release.execute({
        programId: id,
        invoiceId: 'INV-1',
        releaseId,
        amount: money(1n, EUR),
        actor: testActor,
      });

    const first = await release('REL-1');
    const second = await release('REL-2');
    const third = await release('REL-3');

    expect([first, second, third].map((result) => result.release.freedMinor)).toEqual([
      333n,
      334n,
      334n,
    ]);
    expect(first.reservation.status).toBe('PARTIALLY_RELEASED');
    expect(third.reservation.status).toBe('RELEASED');
    const details = await services.queries.getReservation(id, 'INV-1');
    expect(details.releases.map((item) => item.releaseId)).toEqual(['REL-1', 'REL-2', 'REL-3']);
    await expectInvariants(database.db, id);
  });

  it('replays a release with the same releaseId and payload without changing anything', async () => {
    const id = await programWithReservation();
    const command = {
      programId: id,
      invoiceId: 'INV-1',
      releaseId: 'REL-1',
      amount: money(1n, EUR),
      actor: testActor,
    };
    const first = await services.release.execute(command);
    const before = await programState(database.db, id);

    const replay = await services.release.execute(command);

    expect(replay.created).toBe(false);
    expect(replay.release).toEqual(first.release);
    expect(await programState(database.db, id)).toEqual(before);
  });

  it('replays a full release even after the reservation is fully released', async () => {
    const id = await programWithReservation();
    const command = {
      programId: id,
      invoiceId: 'INV-1',
      releaseId: 'REL-1',
      amount: null,
      actor: testActor,
    };
    await services.release.execute(command);

    await expect(services.release.execute(command)).resolves.toMatchObject({ created: false });
  });

  it('rejects reusing a releaseId with a different payload', async () => {
    const id = await programWithReservation();
    await services.release.execute({
      programId: id,
      invoiceId: 'INV-1',
      releaseId: 'REL-1',
      amount: money(1n, EUR),
      actor: testActor,
    });

    await expect(
      services.release.execute({
        programId: id,
        invoiceId: 'INV-1',
        releaseId: 'REL-1',
        amount: money(2n, EUR),
        actor: testActor,
      }),
    ).rejects.toBeInstanceOf(ReleaseConflictError);
    await expect(
      services.release.execute({
        programId: id,
        invoiceId: 'INV-1',
        releaseId: 'REL-1',
        amount: null,
        actor: testActor,
      }),
    ).rejects.toBeInstanceOf(ReleaseConflictError);
  });

  it('rejects a new release of a fully released reservation', async () => {
    const id = await programWithReservation();
    await services.release.execute({
      programId: id,
      invoiceId: 'INV-1',
      releaseId: 'REL-1',
      amount: null,
      actor: testActor,
    });

    await expect(
      services.release.execute({
        programId: id,
        invoiceId: 'INV-1',
        releaseId: 'REL-2',
        amount: null,
        actor: testActor,
      }),
    ).rejects.toBeInstanceOf(ReservationAlreadyReleasedError);
  });

  it('rejects over-releases and wrong currencies without writing anything', async () => {
    const id = await programWithReservation();
    const before = await programState(database.db, id);

    await expect(
      services.release.execute({
        programId: id,
        invoiceId: 'INV-1',
        releaseId: 'REL-1',
        amount: money(4n, EUR),
        actor: testActor,
      }),
    ).rejects.toBeInstanceOf(OverReleaseError);
    await expect(
      services.release.execute({
        programId: id,
        invoiceId: 'INV-1',
        releaseId: 'REL-1',
        amount: money(1n, USD),
        actor: testActor,
      }),
    ).rejects.toBeInstanceOf(ReleaseCurrencyMismatchError);
    expect(await programState(database.db, id)).toEqual(before);
  });

  it('rejects unknown programmes and invoices', async () => {
    const id = await programWithReservation();

    await expect(
      services.release.execute({
        programId: 'PRG-MISSING',
        invoiceId: 'INV-1',
        releaseId: 'REL-1',
        amount: null,
        actor: testActor,
      }),
    ).rejects.toBeInstanceOf(ProgramNotFoundError);
    await expect(
      services.release.execute({
        programId: id,
        invoiceId: 'INV-MISSING',
        releaseId: 'REL-1',
        amount: null,
        actor: testActor,
      }),
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
  });

  it('applies a concurrently repeated release exactly once', async () => {
    const id = await programWithReservation();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        services.release.execute({
          programId: id,
          invoiceId: 'INV-1',
          releaseId: 'REL-1',
          amount: null,
          actor: testActor,
        }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect((await programState(database.db, id)).releases).toBe(1);
    await expectInvariants(database.db, id);
  });

  it('lets only one of several concurrent full releases with different releaseIds succeed', async () => {
    const id = await programWithReservation();

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        services.release.execute({
          programId: id,
          invoiceId: 'INV-1',
          releaseId: `REL-${index}`,
          amount: null,
          actor: testActor,
        }),
      ),
    );

    const rejected = results.filter((result) => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      rejected.every((result) => result.reason instanceof ReservationAlreadyReleasedError),
    ).toBe(true);
    expect((await services.queries.getCapacity(id)).program.utilisedMinor).toBe(0n);
    await expectInvariants(database.db, id);
  });
});
