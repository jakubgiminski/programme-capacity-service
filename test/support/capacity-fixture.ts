import { sql } from 'kysely';
import { CapacityQueries } from '../../src/capacity/application/capacity-queries';
import { type Actor } from '../../src/capacity/application/commands';
import { ReleaseProcessor } from '../../src/capacity/application/release-processor';
import { ReleaseReservation } from '../../src/capacity/application/release-reservation';
import { ReserveCapacity } from '../../src/capacity/application/reserve-capacity';
import { type Program } from '../../src/capacity/domain/model';
import { CapacityRepository } from '../../src/capacity/infrastructure/capacity.repository';
import { TreasuryRepository } from '../../src/capacity/infrastructure/treasury.repository';
import { ApplyTreasuryMessage } from '../../src/capacity/application/apply-treasury-message';
import { type Db } from '../../src/database/database';
import { type FxRateProvider } from '../../src/fx/fx-rate-provider';
import { type CurrencyCode, type FxRate, Money, parseCurrency, parseFxRate } from '../../src/money';

export const USD = parseCurrency('USD');
export const EUR = parseCurrency('EUR');
export const GBP = parseCurrency('GBP');
export const JPY = parseCurrency('JPY');
export const KWD = parseCurrency('KWD');

export const testActor: Actor = { subject: 'test-client', correlationId: 'corr-1' };

export function money(minor: bigint, currency: CurrencyCode): Money {
  return Money.of(minor, currency);
}

export class FakeFxRateProvider implements FxRateProvider {
  private readonly rates = new Map<string, FxRate>();
  calls = 0;

  set(from: CurrencyCode, to: CurrencyCode, rate: string, source = 'fake'): this {
    this.rates.set(`${from}/${to}`, {
      from,
      to,
      scaled: parseFxRate(rate),
      source,
      asOf: new Date('2026-11-01T00:00:00Z'),
    });
    return this;
  }

  remove(from: CurrencyCode, to: CurrencyCode): void {
    this.rates.delete(`${from}/${to}`);
  }

  getRate(from: CurrencyCode, to: CurrencyCode): Promise<FxRate | null> {
    this.calls += 1;
    if (from === to) {
      return Promise.resolve({
        from,
        to,
        scaled: 10_000_000_000n,
        source: 'identity',
        asOf: new Date('2026-11-01T00:00:00Z'),
      });
    }
    return Promise.resolve(this.rates.get(`${from}/${to}`) ?? null);
  }
}

export interface CapacityServices {
  repository: CapacityRepository;
  reserve: ReserveCapacity;
  release: ReleaseReservation;
  processor: ReleaseProcessor;
  queries: CapacityQueries;
  treasury: ApplyTreasuryMessage;
}

export function buildCapacityServices(db: Db, fx: FxRateProvider): CapacityServices {
  const repository = new CapacityRepository();
  const processor = new ReleaseProcessor(repository);
  const treasuryRepository = new TreasuryRepository();
  return {
    repository,
    processor,
    reserve: new ReserveCapacity(db, fx, repository, treasuryRepository),
    release: new ReleaseReservation(db, repository, processor),
    queries: new CapacityQueries(db, repository, treasuryRepository),
    treasury: new ApplyTreasuryMessage(db, repository, treasuryRepository, processor),
  };
}

export function createProgram(
  db: Db,
  id: string,
  currency: CurrencyCode,
  limitMinor: bigint,
): Promise<Program> {
  return new CapacityRepository().insertProgram(db, { id, currency, limitMinor });
}

export interface ProgramState {
  limitMinor: bigint;
  utilisedMinor: bigint;
  version: bigint;
  ledgerEntries: number;
  reservations: number;
  releases: number;
}

export async function programState(db: Db, programId: string): Promise<ProgramState> {
  const program = await db
    .selectFrom('programs')
    .select(['limit_minor', 'utilised_minor', 'version'])
    .where('id', '=', programId)
    .executeTakeFirstOrThrow();
  const counts = await sql<{ ledger: bigint; reservations: bigint; releases: bigint }>`
    SELECT
      (SELECT count(*) FROM ledger_entries WHERE program_id = ${programId}) AS ledger,
      (SELECT count(*) FROM reservations WHERE program_id = ${programId}) AS reservations,
      (SELECT count(*) FROM releases r JOIN reservations res ON res.id = r.reservation_id
        WHERE res.program_id = ${programId}) AS releases
  `.execute(db);
  const row = counts.rows[0]!;
  return {
    limitMinor: program.limit_minor,
    utilisedMinor: program.utilised_minor,
    version: program.version,
    ledgerEntries: Number(row.ledger),
    reservations: Number(row.reservations),
    releases: Number(row.releases),
  };
}

export async function expectInvariants(db: Db, programId: string): Promise<void> {
  const result = await sql<{
    utilised: bigint;
    outstanding: bigint;
    ledger_utilised: bigint;
    last_utilised_after: bigint | null;
    last_limit_after: bigint | null;
    limit_minor: bigint;
  }>`
    SELECT
      p.utilised_minor AS utilised,
      p.limit_minor,
      COALESCE((SELECT sum(booked_minor - released_minor) FROM reservations
        WHERE program_id = p.id AND status <> 'RELEASED'), 0)::bigint AS outstanding,
      COALESCE((SELECT sum(delta_minor) FROM ledger_entries
        WHERE program_id = p.id AND type <> 'LIMIT_SET'), 0)::bigint AS ledger_utilised,
      (SELECT utilised_after_minor FROM ledger_entries WHERE program_id = p.id
        ORDER BY id DESC LIMIT 1) AS last_utilised_after,
      (SELECT limit_after_minor FROM ledger_entries WHERE program_id = p.id
        ORDER BY id DESC LIMIT 1) AS last_limit_after
    FROM programs p WHERE p.id = ${programId}
  `.execute(db);
  const row = result.rows[0]!;
  expect(row.utilised).toBe(row.outstanding);
  expect(row.utilised).toBe(row.ledger_utilised);
  expect(row.utilised >= 0n).toBe(true);
  if (row.last_utilised_after !== null) {
    expect(row.last_utilised_after).toBe(row.utilised);
    expect(row.last_limit_after).toBe(row.limit_minor);
  }
}
