import { type FxRate, Money, parseCurrency, parseFxRate } from '../../money';
import { isSameReservationRequest, planBooking, planRelease } from './capacity-rules';
import {
  AmountOutOfRangeCapacityError,
  InsufficientCapacityError,
  OverReleaseError,
  ReleaseCurrencyMismatchError,
  ReservationAlreadyReleasedError,
} from './errors';
import { type Program, type Reservation } from './model';

const USD = parseCurrency('USD');
const EUR = parseCurrency('EUR');
const JPY = parseCurrency('JPY');

function program(overrides: Partial<Program> = {}): Program {
  return {
    id: 'PRG-1',
    currency: USD,
    limitMinor: 1_000_000n,
    utilisedMinor: 0n,
    version: 0n,
    treasuryRevision: 0n,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function reservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 'r-1',
    programId: 'PRG-1',
    invoiceId: 'INV-1',
    status: 'ACTIVE',
    origin: 'API',
    invoiceAmountMinor: 3n,
    invoiceCurrency: EUR,
    invoiceReleasedMinor: 0n,
    bookedMinor: 1_000n,
    releasedMinor: 0n,
    fx: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const eurUsd: FxRate = {
  from: EUR,
  to: USD,
  scaled: parseFxRate('1.085'),
  source: 'test',
  asOf: new Date('2026-11-01T00:00:00Z'),
};

describe('planBooking', () => {
  it('converts with round-up and captures the FX snapshot', () => {
    const plan = planBooking(program(), Money.of(100_001n, EUR), eurUsd);

    expect(plan.bookedMinor).toBe(108_502n);
    expect(plan.fx).toEqual({
      rateScaled: 10_850_000_000n,
      scale: 10,
      source: 'test',
      asOf: eurUsd.asOf,
    });
  });

  it('accepts a reservation that uses exactly the available capacity', () => {
    const plan = planBooking(program({ utilisedMinor: 891_498n }), Money.of(100_001n, EUR), eurUsd);

    expect(plan.bookedMinor).toBe(108_502n);
  });

  it('rejects a reservation one minor unit above the available capacity', () => {
    expect(() =>
      planBooking(program({ utilisedMinor: 891_499n }), Money.of(100_001n, EUR), eurUsd),
    ).toThrow(InsufficientCapacityError);
  });

  it('rejects every reservation while the programme is over-utilised', () => {
    const overUtilised = program({ limitMinor: 100n, utilisedMinor: 150n });
    const identity: FxRate = { ...eurUsd, from: USD, scaled: 10_000_000_000n };

    expect(() => planBooking(overUtilised, Money.of(1n, USD), identity)).toThrow(
      InsufficientCapacityError,
    );
  });

  it('maps conversion overflow to a capacity error', () => {
    const jpyUsd: FxRate = { ...eurUsd, from: JPY, scaled: parseFxRate('900000000') };

    expect(() => planBooking(program(), Money.of(9_000_000_000_000_000_000n, JPY), jpyUsd)).toThrow(
      AmountOutOfRangeCapacityError,
    );
  });
});

describe('isSameReservationRequest', () => {
  it('matches on invoice amount and currency only', () => {
    const existing = reservation({ invoiceAmountMinor: 500n, invoiceCurrency: EUR });

    expect(isSameReservationRequest(existing, Money.of(500n, EUR))).toBe(true);
    expect(isSameReservationRequest(existing, Money.of(501n, EUR))).toBe(false);
    expect(isSameReservationRequest(existing, Money.of(500n, USD))).toBe(false);
  });
});

describe('planRelease', () => {
  it('releases everything outstanding when no amount is given', () => {
    const plan = planRelease(reservation(), null);

    expect(plan).toEqual({
      invoiceAmountMinor: 3n,
      freedMinor: 1_000n,
      invoiceReleasedAfterMinor: 3n,
      releasedAfterMinor: 1_000n,
      status: 'RELEASED',
    });
  });

  it('frees the proportional share rounded down and the remainder on the final release', () => {
    const first = planRelease(reservation(), Money.of(1n, EUR));
    expect(first.freedMinor).toBe(333n);
    expect(first.status).toBe('PARTIALLY_RELEASED');

    const second = planRelease(
      reservation({ status: 'PARTIALLY_RELEASED', invoiceReleasedMinor: 1n, releasedMinor: 333n }),
      Money.of(1n, EUR),
    );
    expect(second.freedMinor).toBe(333n);

    const last = planRelease(
      reservation({ status: 'PARTIALLY_RELEASED', invoiceReleasedMinor: 2n, releasedMinor: 666n }),
      Money.of(1n, EUR),
    );
    expect(last.freedMinor).toBe(334n);
    expect(last.status).toBe('RELEASED');
  });

  it('can free nothing for a tiny partial release while still recording it', () => {
    const plan = planRelease(
      reservation({ invoiceAmountMinor: 1_000_000n, bookedMinor: 10n }),
      Money.of(1n, EUR),
    );

    expect(plan.freedMinor).toBe(0n);
    expect(plan.invoiceReleasedAfterMinor).toBe(1n);
    expect(plan.status).toBe('PARTIALLY_RELEASED');
  });

  it('never frees less than zero when the booking was lowered after earlier releases', () => {
    const plan = planRelease(
      reservation({
        status: 'PARTIALLY_RELEASED',
        invoiceAmountMinor: 100n,
        invoiceReleasedMinor: 50n,
        bookedMinor: 600n,
        releasedMinor: 500n,
      }),
      Money.of(10n, EUR),
    );

    expect(plan.freedMinor).toBe(0n);
    expect(plan.releasedAfterMinor).toBe(500n);
  });

  it('rejects releasing more than is outstanding', () => {
    expect(() =>
      planRelease(
        reservation({ invoiceReleasedMinor: 2n, status: 'PARTIALLY_RELEASED' }),
        Money.of(2n, EUR),
      ),
    ).toThrow(OverReleaseError);
  });

  it('rejects a release in a different currency', () => {
    expect(() => planRelease(reservation(), Money.of(1n, USD))).toThrow(
      ReleaseCurrencyMismatchError,
    );
  });

  it('rejects releasing a fully released reservation', () => {
    expect(() =>
      planRelease(
        reservation({ status: 'RELEASED', invoiceReleasedMinor: 3n, releasedMinor: 1_000n }),
        null,
      ),
    ).toThrow(ReservationAlreadyReleasedError);
  });
});
