import { createHash } from 'node:crypto';
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
import { TreasuryRepository } from '../../src/capacity/infrastructure/treasury.repository';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { inbound, invoiceRepaid, limitSet, snapshot } from '../support/treasury-messages';

describe('ApplyTreasuryMessage (Postgres)', () => {
  let database: TestDatabase;
  let services: CapacityServices;
  let sequence = 0;

  function nextProgramId(): string {
    sequence += 1;
    return `PRG-T-${sequence}`;
  }

  function apply(message: Record<string, unknown>) {
    return services.treasury.execute(inbound(message));
  }

  async function outcomes(programId: string) {
    return database.db
      .selectFrom('processed_messages')
      .select(['message_id', 'outcome'])
      .where('program_id', '=', programId)
      .orderBy('revision')
      .orderBy('message_id')
      .execute();
  }

  async function streamRevision(programId: string): Promise<bigint> {
    const row = await database.db
      .selectFrom('treasury_streams')
      .select('revision')
      .where('program_id', '=', programId)
      .executeTakeFirstOrThrow();
    return row.revision;
  }

  async function deadLetters(programId: string) {
    return database.db
      .selectFrom('treasury_dead_letters')
      .select(['message_id', 'reason'])
      .where('program_id', '=', programId)
      .orderBy('id')
      .execute();
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    services = buildCapacityServices(database.db, new FakeFxRateProvider().set(EUR, USD, '1.1'));
  });

  afterAll(async () => {
    await database.destroy();
  });

  it('creates a programme from its first ProgramLimitSet and changes the limit later', async () => {
    const id = nextProgramId();

    const created = await apply(limitSet(`${id}-1`, id, 1, '500000'));
    const changed = await apply(limitSet(`${id}-2`, id, 2, '750000'));

    expect(created.outcome).toBe('APPLIED');
    expect(changed.outcome).toBe('APPLIED');
    const capacity = await services.queries.getCapacity(id);
    expect(capacity.program).toMatchObject({ currency: USD, limitMinor: 750_000n });
    expect(await streamRevision(id)).toBe(2n);
    const ledger = await database.db
      .selectFrom('ledger_entries')
      .select(['type', 'delta_minor', 'reason', 'source_message_id', 'actor'])
      .where('program_id', '=', id)
      .orderBy('id')
      .execute();
    expect(ledger).toEqual([
      {
        type: 'LIMIT_SET',
        delta_minor: 500_000n,
        reason: 'PROGRAM_CREATED',
        source_message_id: `${id}-1`,
        actor: 'treasury',
      },
      {
        type: 'LIMIT_SET',
        delta_minor: 250_000n,
        reason: 'TREASURY_LIMIT_SET',
        source_message_id: `${id}-2`,
        actor: 'treasury',
      },
    ]);
  });

  it('skips duplicates and stale deltas without touching state', async () => {
    const id = nextProgramId();
    await apply(limitSet(`${id}-1`, id, 1, '1000'));
    await apply(limitSet(`${id}-2`, id, 2, '2000'));
    const before = await programState(database.db, id);

    const duplicate = await apply(limitSet(`${id}-2`, id, 2, '2000'));
    const stale = await apply(limitSet(`${id}-stale`, id, 1, '99'));

    expect(duplicate.outcome).toBe('DUPLICATE');
    expect(stale.outcome).toBe('STALE');
    expect(await programState(database.db, id)).toEqual(before);
  });

  it('parks a message after a revision gap and drains it once the gap closes', async () => {
    const id = nextProgramId();
    await apply(limitSet(`${id}-1`, id, 1, '1000'));

    const parkedThree = await apply(limitSet(`${id}-3`, id, 3, '3000'));
    const parkedFour = await apply(limitSet(`${id}-4`, id, 4, '4000'));
    expect(parkedThree.outcome).toBe('PARKED');
    expect(parkedFour.outcome).toBe('PARKED');
    expect((await services.queries.getCapacity(id)).program.limitMinor).toBe(1_000n);

    const closing = await apply(limitSet(`${id}-2`, id, 2, '2000'));

    expect(closing).toMatchObject({ outcome: 'APPLIED', drained: 2 });
    const program = (await services.queries.getCapacity(id)).program;
    expect(program.limitMinor).toBe(4_000n);
    expect(await streamRevision(id)).toBe(4n);
    expect(await outcomes(id)).toEqual([
      { message_id: `${id}-1`, outcome: 'APPLIED' },
      { message_id: `${id}-2`, outcome: 'APPLIED' },
      { message_id: `${id}-3`, outcome: 'APPLIED' },
      { message_id: `${id}-4`, outcome: 'APPLIED' },
    ]);
    const pending = await database.db
      .selectFrom('pending_treasury_messages')
      .select('message_id')
      .where('program_id', '=', id)
      .execute();
    expect(pending).toEqual([]);
  });

  it('parks deltas for an unknown programme until it is created', async () => {
    const id = nextProgramId();

    expect((await apply(limitSet(`${id}-2`, id, 2, '2000'))).outcome).toBe('PARKED');
    const created = await apply(limitSet(`${id}-1`, id, 1, '1000'));

    expect(created).toMatchObject({ outcome: 'APPLIED', drained: 1 });
    expect((await services.queries.getCapacity(id)).program.limitMinor).toBe(2_000n);
  });

  it('applies a snapshot ahead of parked deltas and supersedes the ones it covers', async () => {
    const id = nextProgramId();
    await apply(limitSet(`${id}-1`, id, 1, '1000'));
    await apply(limitSet(`${id}-3`, id, 3, '3000'));
    await apply(limitSet(`${id}-6`, id, 6, '6000'));

    const applied = await apply(snapshot(`${id}-5`, id, 5, '5000', []));
    const late = await apply(limitSet(`${id}-4`, id, 4, '4000'));

    expect(applied).toMatchObject({ outcome: 'APPLIED', drained: 1 });
    expect(late.outcome).toBe('STALE');
    const program = (await services.queries.getCapacity(id)).program;
    expect(program.limitMinor).toBe(6_000n);
    expect(await streamRevision(id)).toBe(6n);
    expect(await outcomes(id)).toEqual([
      { message_id: `${id}-1`, outcome: 'APPLIED' },
      { message_id: `${id}-3`, outcome: 'SUPERSEDED' },
      { message_id: `${id}-4`, outcome: 'STALE' },
      { message_id: `${id}-5`, outcome: 'APPLIED' },
      { message_id: `${id}-6`, outcome: 'APPLIED' },
    ]);
  });

  it('ignores a stale snapshot', async () => {
    const id = nextProgramId();
    await apply(snapshot(`${id}-5`, id, 5, '5000', []));
    const before = await programState(database.db, id);

    const stale = await apply(snapshot(`${id}-4`, id, 4, '1', []));

    expect(stale.outcome).toBe('STALE');
    expect(await programState(database.db, id)).toEqual(before);
  });

  it('releases through the shared release path on InvoiceRepaid', async () => {
    const id = nextProgramId();
    await apply(limitSet(`${id}-1`, id, 1, '100000'));
    await services.reserve.execute({
      programId: id,
      invoiceId: 'INV-1',
      invoiceAmount: money(10_000n, EUR),
      actor: testActor,
    });

    const partial = await apply(
      invoiceRepaid(`${id}-2`, id, 2, 'INV-1', 'TR-1', { amount: '2500', currency: 'EUR' }),
    );
    const replayedRelease = await apply(
      invoiceRepaid(`${id}-3`, id, 3, 'INV-1', 'TR-1', { amount: '2500', currency: 'EUR' }),
    );

    expect(partial.outcome).toBe('APPLIED');
    expect(replayedRelease.outcome).toBe('APPLIED');
    const details = await services.queries.getReservation(id, 'INV-1');
    expect(details.reservation).toMatchObject({
      status: 'PARTIALLY_RELEASED',
      releasedMinor: 2_750n,
    });
    expect(details.releases).toEqual([
      expect.objectContaining({ releaseId: 'TR-1', origin: 'TREASURY', actor: 'treasury' }),
    ]);
    const ledger = await database.db
      .selectFrom('ledger_entries')
      .select(['source_message_id'])
      .where('program_id', '=', id)
      .where('type', '=', 'RELEASE')
      .execute();
    expect(ledger).toEqual([{ source_message_id: `${id}-2` }]);
    await expectInvariants(database.db, id);
  });

  it('dead-letters semantic rejections and still advances the revision', async () => {
    const id = nextProgramId();
    await apply(limitSet(`${id}-1`, id, 1, '100000'));
    await apply(limitSet(`${id}-4`, id, 4, '400000'));

    const unknownInvoice = await apply(invoiceRepaid(`${id}-2`, id, 2, 'INV-404', 'TR-1'));
    const currencyChange = await apply(limitSet(`${id}-3`, id, 3, '300000', 'EUR'));

    expect(unknownInvoice).toMatchObject({ outcome: 'REJECTED', deadLettered: 1 });
    expect(unknownInvoice.reason).toMatch(/reservation-not-found/);
    expect(currencyChange).toMatchObject({ outcome: 'REJECTED', drained: 1 });
    const program = (await services.queries.getCapacity(id)).program;
    expect(program).toMatchObject({ currency: USD, limitMinor: 400_000n });
    expect(await streamRevision(id)).toBe(4n);
    expect((await deadLetters(id)).map((row) => row.message_id)).toEqual([`${id}-2`, `${id}-3`]);
  });

  it('dead-letters an invalid body and a repayment for an unknown programme', async () => {
    const id = nextProgramId();

    const unknownProgram = await apply(invoiceRepaid(`${id}-1`, id, 1, 'INV-1', 'TR-1'));
    const created = await apply(limitSet(`${id}-2`, id, 2, '1000'));
    const invalid = await apply({ ...limitSet(`${id}-3`, id, 3, '1000'), limit: '-5' });
    const next = await apply(limitSet(`${id}-4`, id, 4, '4000'));

    expect(unknownProgram.outcome).toBe('REJECTED');
    expect(created.outcome).toBe('APPLIED');
    expect(invalid.outcome).toBe('REJECTED');
    expect(invalid.reason).toMatch(/Invalid ProgramLimitSet/);
    expect(next.outcome).toBe('APPLIED');
    expect((await services.queries.getCapacity(id)).program.limitMinor).toBe(4_000n);
    expect(await streamRevision(id)).toBe(4n);
  });

  it('consumes a snapshot rejected ahead of a gap once the gap closes', async () => {
    const id = nextProgramId();
    await apply(limitSet(`${id}-1`, id, 1, '1000'));

    const currencyChange = await apply(snapshot(`${id}-4`, id, 4, '4000', [], 'EUR'));
    const parked = await apply(limitSet(`${id}-5`, id, 5, '5000'));
    await apply(limitSet(`${id}-2`, id, 2, '2000'));
    const closing = await apply(limitSet(`${id}-3`, id, 3, '3000'));

    expect(currencyChange).toMatchObject({ outcome: 'REJECTED', deadLettered: 1 });
    expect(parked.outcome).toBe('PARKED');
    expect(closing).toMatchObject({ outcome: 'APPLIED', drained: 2, deadLettered: 0 });
    expect((await services.queries.getCapacity(id)).program.limitMinor).toBe(5_000n);
    expect(await streamRevision(id)).toBe(5n);
    expect((await deadLetters(id)).map((row) => row.message_id)).toEqual([`${id}-4`]);
    expect(await outcomes(id)).toEqual([
      { message_id: `${id}-1`, outcome: 'APPLIED' },
      { message_id: `${id}-2`, outcome: 'APPLIED' },
      { message_id: `${id}-3`, outcome: 'APPLIED' },
      { message_id: `${id}-4`, outcome: 'REJECTED' },
      { message_id: `${id}-5`, outcome: 'APPLIED' },
    ]);
  });

  it('rejects a second message parked for the same revision', async () => {
    const id = nextProgramId();
    await apply(limitSet(`${id}-1`, id, 1, '1000'));
    await apply(limitSet(`${id}-3a`, id, 3, '3000'));

    const conflicting = await apply(limitSet(`${id}-3b`, id, 3, '9999'));

    expect(conflicting.outcome).toBe('REJECTED');
    expect((await deadLetters(id)).map((row) => row.message_id)).toEqual([`${id}-3b`]);
  });

  it('persists the fail-safe merge, its audit trail and its discrepancies', async () => {
    const id = nextProgramId();
    await createProgram(database.db, id, USD, 100_000n);
    const reserve = (invoiceId: string, amount: bigint) =>
      services.reserve.execute({
        programId: id,
        invoiceId,
        invoiceAmount: money(amount, USD),
        actor: testActor,
      });
    await reserve('API-HIGHER', 1_000n);
    await reserve('API-LOWER', 2_000n);
    await reserve('API-MISSING', 3_000n);
    await reserve('API-RELEASED', 4_000n);
    await services.release.execute({
      programId: id,
      invoiceId: 'API-RELEASED',
      releaseId: 'R-1',
      amount: null,
      actor: testActor,
    });
    await apply(
      snapshot(`${id}-1`, id, 1, '100000', [
        {
          invoiceId: 'TRE-KEEP',
          invoiceAmount: '500',
          invoiceCurrency: 'USD',
          bookedAmount: '500',
        },
        {
          invoiceId: 'TRE-GONE',
          invoiceAmount: '600',
          invoiceCurrency: 'USD',
          bookedAmount: '600',
        },
        {
          invoiceId: 'TRE-LOWER',
          invoiceAmount: '700',
          invoiceCurrency: 'USD',
          bookedAmount: '700',
        },
      ]),
    );
    const beforeMerge = (await services.queries.getCapacity(id)).program.utilisedMinor;
    expect(beforeMerge).toBe(1_000n + 2_000n + 3_000n + 500n + 600n + 700n);

    const result = await apply(
      snapshot(`${id}-2`, id, 2, '5000', [
        {
          invoiceId: 'API-HIGHER',
          invoiceAmount: '1000',
          invoiceCurrency: 'USD',
          bookedAmount: '1500',
        },
        {
          invoiceId: 'API-LOWER',
          invoiceAmount: '2000',
          invoiceCurrency: 'USD',
          bookedAmount: '100',
        },
        {
          invoiceId: 'API-RELEASED',
          invoiceAmount: '4000',
          invoiceCurrency: 'USD',
          bookedAmount: '4000',
        },
        {
          invoiceId: 'TRE-KEEP',
          invoiceAmount: '500',
          invoiceCurrency: 'USD',
          bookedAmount: '500',
        },
        {
          invoiceId: 'TRE-LOWER',
          invoiceAmount: '700',
          invoiceCurrency: 'USD',
          bookedAmount: '200',
        },
        { invoiceId: 'TRE-NEW', invoiceAmount: '800', invoiceCurrency: 'USD', bookedAmount: '800' },
      ]),
    );

    expect(result.outcome).toBe('APPLIED');
    const capacity = await services.queries.getCapacity(id);
    expect(capacity.program.limitMinor).toBe(5_000n);
    expect(capacity.program.utilisedMinor).toBe(1_500n + 2_000n + 3_000n + 500n + 200n + 800n);
    expect(capacity.availableMinor).toBe(-3_000n);
    expect(capacity.overUtilised).toBe(true);
    expect(capacity.openDiscrepancies).toBe(3);
    const gone = await services.queries.getReservation(id, 'TRE-GONE');
    expect(gone.reservation.status).toBe('RELEASED');
    const released = await services.queries.getReservation(id, 'API-RELEASED');
    expect(released.reservation.status).toBe('RELEASED');
    const discrepancies = await services.queries.listOpenDiscrepancies(id);
    expect(discrepancies.discrepancies.map((item) => [item.invoiceId, item.kind])).toEqual([
      ['API-LOWER', 'TREASURY_AMOUNT_LOWER'],
      ['API-MISSING', 'MISSING_FROM_SNAPSHOT'],
      ['API-RELEASED', 'RELEASED_LOCALLY'],
    ]);
    const adjustments = await database.db
      .selectFrom('ledger_entries')
      .select(['type', 'delta_minor', 'reason', 'source_message_id'])
      .where('program_id', '=', id)
      .where('source_message_id', '=', `${id}-2`)
      .orderBy('id')
      .execute();
    expect(adjustments).toEqual([
      {
        type: 'LIMIT_SET',
        delta_minor: -95_000n,
        reason: 'SNAPSHOT_LIMIT',
        source_message_id: `${id}-2`,
      },
      {
        type: 'RECONCILE_ADJUST',
        delta_minor: -600n,
        reason: 'MISSING_FROM_SNAPSHOT',
        source_message_id: `${id}-2`,
      },
      {
        type: 'RECONCILE_ADJUST',
        delta_minor: -500n,
        reason: 'TREASURY_AMOUNT_LOWER',
        source_message_id: `${id}-2`,
      },
      {
        type: 'RECONCILE_ADJUST',
        delta_minor: 500n,
        reason: 'TREASURY_AMOUNT_HIGHER',
        source_message_id: `${id}-2`,
      },
      {
        type: 'RECONCILE_ADJUST',
        delta_minor: 800n,
        reason: 'IMPORTED_FROM_SNAPSHOT',
        source_message_id: `${id}-2`,
      },
    ]);
    await expect(
      services.reserve.execute({
        programId: id,
        invoiceId: 'NEW',
        invoiceAmount: money(1n, USD),
        actor: testActor,
      }),
    ).rejects.toMatchObject({ code: 'insufficient-capacity' });
    await expectInvariants(database.db, id);

    await apply(
      snapshot(`${id}-3`, id, 3, '20000', [
        {
          invoiceId: 'API-HIGHER',
          invoiceAmount: '1000',
          invoiceCurrency: 'USD',
          bookedAmount: '1500',
        },
        {
          invoiceId: 'API-LOWER',
          invoiceAmount: '2000',
          invoiceCurrency: 'USD',
          bookedAmount: '100',
        },
        {
          invoiceId: 'API-MISSING',
          invoiceAmount: '3000',
          invoiceCurrency: 'USD',
          bookedAmount: '3000',
        },
        {
          invoiceId: 'TRE-KEEP',
          invoiceAmount: '500',
          invoiceCurrency: 'USD',
          bookedAmount: '500',
        },
        {
          invoiceId: 'TRE-LOWER',
          invoiceAmount: '700',
          invoiceCurrency: 'USD',
          bookedAmount: '200',
        },
        { invoiceId: 'TRE-NEW', invoiceAmount: '800', invoiceCurrency: 'USD', bookedAmount: '800' },
      ]),
    );
    const after = await services.queries.listOpenDiscrepancies(id);
    expect(after.discrepancies.map((item) => [item.invoiceId, item.snapshotRevision])).toEqual([
      ['API-LOWER', 3n],
    ]);
    await expectInvariants(database.db, id);
  });

  it('allocates repayments after a rebook against the remaining invoice and exposure', async () => {
    const id = nextProgramId();
    const entry = { invoiceId: 'TRE-1', invoiceAmount: '100', invoiceCurrency: 'USD' };
    await apply(snapshot(`${id}-1`, id, 1, '100000', [{ ...entry, bookedAmount: '100' }]));
    await apply(
      invoiceRepaid(`${id}-2`, id, 2, 'TRE-1', 'TR-1', { amount: '50', currency: 'USD' }),
    );
    await apply(
      snapshot(`${id}-3`, id, 3, '100000', [
        { ...entry, outstandingInvoiceAmount: '50', bookedAmount: '100' },
      ]),
    );

    await apply(invoiceRepaid(`${id}-4`, id, 4, 'TRE-1', 'TR-2', { amount: '1', currency: 'USD' }));
    await apply(invoiceRepaid(`${id}-5`, id, 5, 'TRE-1', 'TR-3'));

    const details = await services.queries.getReservation(id, 'TRE-1');
    expect(details.releases.map((release) => release.freedMinor)).toEqual([50n, 2n, 98n]);
    expect(details.reservation).toMatchObject({
      status: 'RELEASED',
      bookedMinor: 150n,
      releasedMinor: 150n,
    });
    await expectInvariants(database.db, id);
  });

  it('ends in the same state whether a snapshot arrives before or after a repayment it covers', async () => {
    const entry = { invoiceId: 'TRE-1', invoiceAmount: '100', invoiceCurrency: 'USD' };
    const messages = (id: string) => [
      snapshot(`${id}-1`, id, 1, '100000', [{ ...entry, bookedAmount: '100' }]),
      invoiceRepaid(`${id}-2`, id, 2, 'TRE-1', 'TR-1', { amount: '40', currency: 'USD' }),
      snapshot(`${id}-3`, id, 3, '100000', [
        { ...entry, outstandingInvoiceAmount: '60', bookedAmount: '60' },
      ]),
      invoiceRepaid(`${id}-4`, id, 4, 'TRE-1', 'TR-2', { amount: '60', currency: 'USD' }),
    ];
    const inOrder = nextProgramId();
    const outOfOrder = nextProgramId();

    for (const message of messages(inOrder)) {
      await apply(message);
    }
    const [first, second, third, fourth] = messages(outOfOrder);
    const results = [];
    for (const message of [first!, third!, second!, fourth!]) {
      results.push((await apply(message)).outcome);
    }

    expect(results).toEqual(['APPLIED', 'APPLIED', 'STALE', 'APPLIED']);
    for (const id of [inOrder, outOfOrder]) {
      const details = await services.queries.getReservation(id, 'TRE-1');
      expect(details.reservation).toMatchObject({
        status: 'RELEASED',
        invoiceReleasedMinor: 100n,
      });
      expect((await services.queries.getCapacity(id)).program.utilisedMinor).toBe(0n);
      await expectInvariants(database.db, id);
    }
  });

  it('imports a partially repaid invoice and releases it fully on the final repayment', async () => {
    const id = nextProgramId();
    await apply(
      snapshot(`${id}-1`, id, 1, '100000', [
        {
          invoiceId: 'TRE-1',
          invoiceAmount: '100',
          invoiceCurrency: 'USD',
          outstandingInvoiceAmount: '60',
          bookedAmount: '60',
        },
      ]),
    );

    const imported = await services.queries.getReservation(id, 'TRE-1');
    const partial = await apply(
      invoiceRepaid(`${id}-2`, id, 2, 'TRE-1', 'TR-1', { amount: '30', currency: 'USD' }),
    );
    const final = await apply(
      invoiceRepaid(`${id}-3`, id, 3, 'TRE-1', 'TR-2', { amount: '30', currency: 'USD' }),
    );

    expect(imported.reservation).toMatchObject({
      status: 'PARTIALLY_RELEASED',
      invoiceReleasedMinor: 40n,
      bookedMinor: 60n,
      releasedMinor: 0n,
    });
    expect([partial.outcome, final.outcome]).toEqual(['APPLIED', 'APPLIED']);
    const details = await services.queries.getReservation(id, 'TRE-1');
    expect(details.releases.map((release) => release.freedMinor)).toEqual([30n, 30n]);
    expect(details.reservation.status).toBe('RELEASED');
    await expectInvariants(database.db, id);
  });

  it('refuses an API reservation for an invoice treasury already tracks', async () => {
    const id = nextProgramId();
    await apply(
      snapshot(`${id}-1`, id, 1, '100000', [
        { invoiceId: 'TRE-1', invoiceAmount: '100', invoiceCurrency: 'USD', bookedAmount: '0' },
      ]),
    );
    const before = await programState(database.db, id);

    await expect(
      services.reserve.execute({
        programId: id,
        invoiceId: 'TRE-1',
        invoiceAmount: money(100n, USD),
        actor: testActor,
      }),
    ).rejects.toThrow(/tracked from treasury/);
    expect(await programState(database.db, id)).toEqual(before);
  });

  it('admits reservations against a lower limit parked behind a gap', async () => {
    const id = nextProgramId();
    await apply(limitSet(`${id}-1`, id, 1, '1000'));
    const reserve = (invoiceId: string, minor: bigint) =>
      services.reserve.execute({
        programId: id,
        invoiceId,
        invoiceAmount: money(minor, USD),
        actor: testActor,
      });

    const parked = await apply(limitSet(`${id}-3`, id, 3, '300'));
    const gap = await services.queries.getCapacity(id);
    await reserve('INV-1', 300n);
    await expect(reserve('INV-2', 1n)).rejects.toMatchObject({
      code: 'insufficient-capacity',
      availableMinor: 0n,
    });
    await apply(limitSet(`${id}-2`, id, 2, '2000'));
    const closed = await services.queries.getCapacity(id);

    expect(parked.outcome).toBe('PARKED');
    expect(gap.program.limitMinor).toBe(1_000n);
    expect(gap.availableMinor).toBe(300n);
    expect(gap.treasury).toMatchObject({
      revision: 1n,
      parkedMessages: 1,
      pendingLimitMinor: 300n,
    });
    expect(gap.treasury.oldestParkedAt).toBeInstanceOf(Date);
    expect(closed.program).toMatchObject({ limitMinor: 300n, utilisedMinor: 300n });
    expect(closed.treasury).toEqual({
      revision: 3n,
      parkedMessages: 0,
      oldestParkedAt: null,
      pendingLimitMinor: null,
    });
    await expectInvariants(database.db, id);
  });

  it('rejects an invalid message ahead of a gap on arrival and keeps its revision slot', async () => {
    const id = nextProgramId();
    await apply(limitSet(`${id}-1`, id, 1, '1000'));

    const invalid = await apply({ ...snapshot(`${id}-3`, id, 3, '3000', []), limit: '-1' });
    const covering = await apply(snapshot(`${id}-4`, id, 4, '4000', []));

    expect(invalid).toMatchObject({ outcome: 'REJECTED', deadLettered: 1 });
    expect(covering.outcome).toBe('APPLIED');
    expect((await deadLetters(id)).map((row) => row.message_id)).toEqual([`${id}-3`]);
    expect(await outcomes(id)).toEqual([
      { message_id: `${id}-1`, outcome: 'APPLIED' },
      { message_id: `${id}-3`, outcome: 'REJECTED' },
      { message_id: `${id}-4`, outcome: 'APPLIED' },
    ]);
    expect(await streamRevision(id)).toBe(4n);
  });

  it('dead-letters a reused message ID that carries a different message', async () => {
    const id = nextProgramId();
    const other = nextProgramId();
    await apply(limitSet(`${id}-1`, id, 1, '1000'));

    const reusedRevision = await apply(limitSet(`${id}-1`, id, 2, '2000'));
    const reusedProgramme = await apply(limitSet(`${id}-1`, other, 1, '5000'));
    const genuineReplay = await apply(limitSet(`${id}-1`, id, 1, '1000'));

    expect(reusedRevision).toMatchObject({ outcome: 'REJECTED', deadLettered: 1 });
    expect(reusedProgramme).toMatchObject({ outcome: 'REJECTED', deadLettered: 1 });
    expect(genuineReplay.outcome).toBe('DUPLICATE');
    expect(await outcomes(id)).toEqual([{ message_id: `${id}-1`, outcome: 'APPLIED' }]);
    expect(await streamRevision(id)).toBe(1n);
    expect((await deadLetters(id)).map((row) => row.reason)).toEqual([
      `Message ID ${id}-1 was already used for a different message`,
    ]);
    expect(await deadLetters(other)).toHaveLength(1);
  });

  it('rejects a snapshot whose asOf is older than the last applied snapshot', async () => {
    const id = nextProgramId();
    await apply({ ...snapshot(`${id}-1`, id, 1, '1000', []), asOf: '2026-11-18T10:00:00Z' });

    const regressing = await apply({
      ...snapshot(`${id}-2`, id, 2, '2000', []),
      asOf: '2026-11-18T09:00:00Z',
    });
    const sameInstant = await apply({
      ...snapshot(`${id}-3`, id, 3, '3000', []),
      asOf: '2026-11-18T10:00:00Z',
    });

    expect(regressing).toMatchObject({ outcome: 'REJECTED', deadLettered: 1 });
    expect(regressing.reason).toMatch(/older than the last applied snapshot/);
    expect(sameInstant.outcome).toBe('APPLIED');
    expect((await services.queries.getCapacity(id)).program.limitMinor).toBe(3_000n);
  });

  it('drains a long backlog in bounded transactions once the gap closes', async () => {
    const id = nextProgramId();
    await apply(limitSet(`${id}-1`, id, 1, '1000'));
    for (let revision = 3; revision <= 252; revision += 1) {
      await apply(limitSet(`${id}-${revision}`, id, revision, String(revision * 10)));
    }

    const closing = await apply(limitSet(`${id}-2`, id, 2, '20'));

    expect(closing).toMatchObject({ outcome: 'APPLIED', drained: 250 });
    expect(await streamRevision(id)).toBe(252n);
    expect((await services.queries.getCapacity(id)).program.limitMinor).toBe(2_520n);
    const parked = await database.db
      .selectFrom('pending_treasury_messages')
      .select('message_id')
      .where('program_id', '=', id)
      .execute();
    expect(parked).toEqual([]);
  });

  it('resumes an interrupted drain when the closing message is redelivered', async () => {
    const id = nextProgramId();
    await apply(limitSet(`${id}-1`, id, 1, '1000'));
    await apply(limitSet(`${id}-3`, id, 3, '3000'));
    const closing = limitSet(`${id}-2`, id, 2, '2000');
    await database.db.transaction().execute(async (trx) => {
      const treasury = new TreasuryRepository();
      await treasury.lockStream(trx, id);
      await treasury.setStreamRevision(trx, id, 2n);
      await trx
        .insertInto('processed_messages')
        .values({
          message_id: `${id}-2`,
          program_id: id,
          revision: 2n,
          type: 'ProgramLimitSet',
          fingerprint: createHash('sha256').update(JSON.stringify(closing)).digest(),
          outcome: 'APPLIED',
          reason: null,
          source_topic: 'treasury.test',
          source_partition: 0,
          source_offset: '0',
        })
        .execute();
    });

    const redelivered = await apply(closing);

    expect(redelivered).toMatchObject({ outcome: 'DUPLICATE', drained: 1 });
    expect(await streamRevision(id)).toBe(3n);
    expect((await services.queries.getCapacity(id)).program.limitMinor).toBe(3_000n);
  });

  it('accepts zero treasury exposure for open and new treasury invoices', async () => {
    const id = nextProgramId();
    const entry = { invoiceId: 'TRE-1', invoiceAmount: '100', invoiceCurrency: 'USD' };
    await apply(snapshot(`${id}-1`, id, 1, '100000', [{ ...entry, bookedAmount: '100' }]));
    await apply(
      invoiceRepaid(`${id}-2`, id, 2, 'TRE-1', 'TR-1', { amount: '50', currency: 'USD' }),
    );

    const zero = await apply(
      snapshot(`${id}-3`, id, 3, '100000', [
        { ...entry, outstandingInvoiceAmount: '50', bookedAmount: '0' },
        { invoiceId: 'TRE-2', invoiceAmount: '40', invoiceCurrency: 'USD', bookedAmount: '0' },
      ]),
    );
    const final = await apply(invoiceRepaid(`${id}-4`, id, 4, 'TRE-1', 'TR-2'));
    const other = await apply(invoiceRepaid(`${id}-5`, id, 5, 'TRE-2', 'TR-3'));

    expect([zero.outcome, final.outcome, other.outcome]).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
    const first = await services.queries.getReservation(id, 'TRE-1');
    expect(first.reservation).toMatchObject({ status: 'RELEASED', bookedMinor: 50n });
    expect(first.releases.map((release) => release.freedMinor)).toEqual([50n, 0n]);
    const second = await services.queries.getReservation(id, 'TRE-2');
    expect(second.reservation).toMatchObject({ status: 'RELEASED', bookedMinor: 0n });
    expect((await services.queries.getCapacity(id)).program.utilisedMinor).toBe(0n);
    await expectInvariants(database.db, id);
  });

  it('imports a snapshot whose ledger insert exceeds the bind-parameter limit', async () => {
    const id = nextProgramId();
    const entries = Array.from({ length: 7_000 }, (_, index) => ({
      invoiceId: `BULK-${index}`,
      invoiceAmount: '10',
      invoiceCurrency: 'USD',
      bookedAmount: '10',
    }));

    const result = await apply(snapshot(`${id}-1`, id, 1, '1000000', entries));
    const replaced = await apply(snapshot(`${id}-2`, id, 2, '1000000', entries.slice(1)));

    expect(result.outcome).toBe('APPLIED');
    expect(replaced.outcome).toBe('APPLIED');
    expect((await services.queries.getCapacity(id)).program.utilisedMinor).toBe(69_990n);
    await expectInvariants(database.db, id);
  });

  it('applies a net-zero swap at the BIGINT boundary without overflowing the ledger', async () => {
    const id = nextProgramId();
    const max = '9223372036854775807';
    await apply(
      snapshot(`${id}-1`, id, 1, max, [
        { invoiceId: 'Z', invoiceAmount: max, invoiceCurrency: 'USD', bookedAmount: max },
      ]),
    );

    const swap = await apply(
      snapshot(`${id}-2`, id, 2, max, [
        { invoiceId: 'A', invoiceAmount: '1', invoiceCurrency: 'USD', bookedAmount: '1' },
        {
          invoiceId: 'Z',
          invoiceAmount: max,
          invoiceCurrency: 'USD',
          bookedAmount: '9223372036854775806',
        },
      ]),
    );

    expect(swap.outcome).toBe('APPLIED');
    expect((await services.queries.getCapacity(id)).program.utilisedMinor).toBe(BigInt(max));
    await expectInvariants(database.db, id);
  });

  it('creates a programme from a snapshot and imports its reservations', async () => {
    const id = nextProgramId();

    await apply(
      snapshot(`${id}-1`, id, 1, '10000', [
        { invoiceId: 'A', invoiceAmount: '100', invoiceCurrency: 'EUR', bookedAmount: '111' },
      ]),
    );

    const details = await services.queries.getReservation(id, 'A');
    expect(details.reservation).toMatchObject({ origin: 'TREASURY', bookedMinor: 111n, fx: null });
    expect((await services.queries.getCapacity(id)).program.utilisedMinor).toBe(111n);
    await expectInvariants(database.db, id);
  });

  it('rejects a snapshot that changes the programme currency', async () => {
    const id = nextProgramId();
    await apply(limitSet(`${id}-1`, id, 1, '1000'));

    const result = await apply(snapshot(`${id}-2`, id, 2, '1000', [], 'EUR'));

    expect(result.outcome).toBe('REJECTED');
    expect(await streamRevision(id)).toBe(2n);
  });

  it('stays consistent when an API release races a snapshot', async () => {
    for (let round = 0; round < 10; round += 1) {
      const id = nextProgramId();
      await apply(limitSet(`${id}-1`, id, 1, '100000'));
      await services.reserve.execute({
        programId: id,
        invoiceId: 'INV-1',
        invoiceAmount: money(1_000n, USD),
        actor: testActor,
      });

      const [release, merge] = await Promise.allSettled([
        services.release.execute({
          programId: id,
          invoiceId: 'INV-1',
          releaseId: 'R-1',
          amount: null,
          actor: testActor,
        }),
        apply(
          snapshot(`${id}-2`, id, 2, '100000', [
            {
              invoiceId: 'INV-1',
              invoiceAmount: '1000',
              invoiceCurrency: 'USD',
              bookedAmount: '1200',
            },
          ]),
        ),
      ]);

      expect(release.status).toBe('fulfilled');
      expect(merge).toMatchObject({ status: 'fulfilled', value: { outcome: 'APPLIED' } });
      const details = await services.queries.getReservation(id, 'INV-1');
      expect(details.reservation.status).toBe('RELEASED');
      expect((await services.queries.getCapacity(id)).program.utilisedMinor).toBe(0n);
      const adjustments = await database.db
        .selectFrom('ledger_entries')
        .select('delta_minor')
        .where('program_id', '=', id)
        .where('type', '=', 'RECONCILE_ADJUST')
        .execute();
      const discrepancies = (await services.queries.listOpenDiscrepancies(id)).discrepancies;
      const snapshotFirst = adjustments.length > 0;
      expect(adjustments).toEqual(snapshotFirst ? [{ delta_minor: 200n }] : []);
      expect(discrepancies.map((item) => item.kind)).toEqual(
        snapshotFirst ? [] : ['RELEASED_LOCALLY'],
      );
      expect(details.reservation.releasedMinor).toBe(snapshotFirst ? 1_200n : 1_000n);
      await expectInvariants(database.db, id);
    }
  });

  it('treats a full replay of an already processed stream as a no-op', async () => {
    const id = nextProgramId();
    const stream = [
      limitSet(`${id}-1`, id, 1, '100000'),
      snapshot(`${id}-2`, id, 2, '90000', [
        { invoiceId: 'A', invoiceAmount: '100', invoiceCurrency: 'USD', bookedAmount: '100' },
      ]),
      invoiceRepaid(`${id}-3`, id, 3, 'A', 'TR-1', { amount: '40', currency: 'USD' }),
      invoiceRepaid(`${id}-4`, id, 4, 'MISSING', 'TR-2'),
      limitSet(`${id}-5`, id, 5, '80000'),
    ];
    for (const message of stream) {
      await apply(message);
    }
    const before = await programState(database.db, id);
    const deadLettersBefore = await deadLetters(id);

    const replay = [];
    for (const message of stream) {
      replay.push((await apply(message)).outcome);
    }

    expect(replay).toEqual(['DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE']);
    expect(await programState(database.db, id)).toEqual(before);
    expect(await deadLetters(id)).toEqual(deadLettersBefore);
    await expectInvariants(database.db, id);
  });
});
