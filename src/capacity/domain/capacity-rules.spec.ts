import fc from 'fast-check';
import { type FxRate, Money, parseCurrency, parseFxRate } from '../../money';
import {
  admissionLimitMinor,
  assertReleasableBy,
  assertReplayableReservation,
  planBooking,
  planRelease,
} from './capacity-rules';
import {
  AmountOutOfRangeCapacityError,
  InsufficientCapacityError,
  InvalidAmountCapacityError,
  InvoiceConflictError,
  OverReleaseError,
  ReleaseCurrencyMismatchError,
  ReservationAlreadyReleasedError,
  TreasuryOwnedReservationError,
} from './errors';
import { type Program, type Reservation, ZERO_ALLOCATION_BASE } from './model';

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
    allocationBase: ZERO_ALLOCATION_BASE,
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
    const plan = planBooking(program(), Money.of(100_001n, EUR), eurUsd, null);

    expect(plan.bookedMinor).toBe(108_502n);
    expect(plan.fx).toEqual({
      rateScaled: 10_850_000_000n,
      scale: 10,
      source: 'test',
      asOf: eurUsd.asOf,
    });
  });

  it('accepts a reservation that uses exactly the available capacity', () => {
    const plan = planBooking(
      program({ utilisedMinor: 891_498n }),
      Money.of(100_001n, EUR),
      eurUsd,
      null,
    );

    expect(plan.bookedMinor).toBe(108_502n);
  });

  it('rejects a reservation one minor unit above the available capacity', () => {
    expect(() =>
      planBooking(program({ utilisedMinor: 891_499n }), Money.of(100_001n, EUR), eurUsd, null),
    ).toThrow(InsufficientCapacityError);
  });

  it('rejects every reservation while the programme is over-utilised', () => {
    const overUtilised = program({ limitMinor: 100n, utilisedMinor: 150n });
    const identity: FxRate = { ...eurUsd, from: USD, scaled: 10_000_000_000n };

    expect(() => planBooking(overUtilised, Money.of(1n, USD), identity, null)).toThrow(
      InsufficientCapacityError,
    );
  });

  it('maps conversion overflow to a capacity error', () => {
    const jpyUsd: FxRate = { ...eurUsd, from: JPY, scaled: parseFxRate('900000000') };

    expect(() =>
      planBooking(program(), Money.of(9_000_000_000_000_000_000n, JPY), jpyUsd, null),
    ).toThrow(AmountOutOfRangeCapacityError);
  });
});

describe('admission against a parked treasury limit', () => {
  it('uses the lower of the applied and the parked limit', () => {
    expect(admissionLimitMinor(program({ limitMinor: 1_000n }), null)).toBe(1_000n);
    expect(admissionLimitMinor(program({ limitMinor: 1_000n }), 400n)).toBe(400n);
    expect(admissionLimitMinor(program({ limitMinor: 1_000n }), 5_000n)).toBe(1_000n);
  });

  it('rejects a booking that fits the applied limit but not a parked lower limit', () => {
    const current = program({ limitMinor: 1_000n, utilisedMinor: 300n });
    const identity: FxRate = { ...eurUsd, from: USD, scaled: 10_000_000_000n };

    expect(planBooking(current, Money.of(100n, USD), identity, 400n).bookedMinor).toBe(100n);
    expect(() => planBooking(current, Money.of(101n, USD), identity, 400n)).toThrow(
      InsufficientCapacityError,
    );
  });
});

describe('assertReleasableBy', () => {
  it('lets treasury release any reservation and the API only its own', () => {
    const api = reservation({ origin: 'API' });
    const imported = reservation({ origin: 'TREASURY' });

    expect(() => {
      assertReleasableBy(api, 'API');
      assertReleasableBy(api, 'TREASURY');
      assertReleasableBy(imported, 'TREASURY');
    }).not.toThrow();
    expect(() => {
      assertReleasableBy(imported, 'API');
    }).toThrow(TreasuryOwnedReservationError);
  });
});

describe('assertReplayableReservation', () => {
  it('accepts the same invoice amount and currency for an API reservation', () => {
    const existing = reservation({ invoiceAmountMinor: 500n, invoiceCurrency: EUR });

    expect(() => {
      assertReplayableReservation(existing, Money.of(500n, EUR));
    }).not.toThrow();
  });

  it.each([
    ['a different amount', Money.of(501n, EUR)],
    ['a different currency', Money.of(500n, USD)],
  ])('rejects %s', (_label, amount) => {
    const existing = reservation({ invoiceAmountMinor: 500n, invoiceCurrency: EUR });

    expect(() => {
      assertReplayableReservation(existing, amount);
    }).toThrow(InvoiceConflictError);
  });

  it('never replays a reservation that treasury introduced', () => {
    const imported = reservation({ origin: 'TREASURY', invoiceAmountMinor: 500n, bookedMinor: 0n });

    expect(() => {
      assertReplayableReservation(imported, Money.of(500n, EUR));
    }).toThrow(/tracked from treasury/);
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

  it('allocates repayments after a reconciliation against the remaining invoice and exposure', () => {
    const rebooked = reservation({
      status: 'PARTIALLY_RELEASED',
      invoiceAmountMinor: 100n,
      invoiceReleasedMinor: 50n,
      bookedMinor: 150n,
      releasedMinor: 50n,
      allocationBase: { invoiceReleasedMinor: 50n, releasedMinor: 50n },
    });

    const small = planRelease(rebooked, Money.of(1n, EUR));
    const half = planRelease(rebooked, Money.of(25n, EUR));
    const rest = planRelease(rebooked, null);

    expect(small.freedMinor).toBe(2n);
    expect(half.freedMinor).toBe(50n);
    expect(rest.freedMinor).toBe(100n);
  });

  it('closes a partially repaid invoice with zero exposure on its final repayment', () => {
    const plan = planRelease(
      reservation({
        status: 'PARTIALLY_RELEASED',
        invoiceAmountMinor: 100n,
        invoiceReleasedMinor: 50n,
        bookedMinor: 500n,
        releasedMinor: 500n,
      }),
      null,
    );

    expect(plan).toMatchObject({ invoiceAmountMinor: 50n, freedMinor: 0n, status: 'RELEASED' });
  });

  it('rejects zero amounts', () => {
    expect(() => planRelease(reservation(), Money.of(0n, EUR))).toThrow(InvalidAmountCapacityError);
    expect(() => planBooking(program(), Money.of(0n, EUR), eurUsd, null)).toThrow(
      InvalidAmountCapacityError,
    );
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

describe('partial release allocation (property)', () => {
  function releaseInSlices(start: Reservation, slices: readonly bigint[]): bigint[] {
    let current = start;
    return slices.map((slice) => {
      const plan = planRelease(current, Money.of(slice, current.invoiceCurrency));
      current = {
        ...current,
        status: plan.status,
        invoiceReleasedMinor: plan.invoiceReleasedAfterMinor,
        releasedMinor: plan.releasedAfterMinor,
      };
      return plan.freedMinor;
    });
  }

  it('frees the proportional share rounded down and exactly the booking at the end', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 6n }), { minLength: 1, maxLength: 20 }),
        (booked, slices) => {
          const invoiceAmount = slices.reduce((sum, slice) => sum + slice, 0n);
          const freed = releaseInSlices(
            reservation({ invoiceAmountMinor: invoiceAmount, bookedMinor: booked }),
            slices,
          );
          let cumulativeInvoice = 0n;
          let cumulativeFreed = 0n;
          freed.forEach((amount, index) => {
            cumulativeInvoice += slices[index]!;
            cumulativeFreed += amount;
            expect(amount >= 0n).toBe(true);
            expect(cumulativeFreed * invoiceAmount <= booked * cumulativeInvoice).toBe(true);
            expect((cumulativeFreed + 1n) * invoiceAmount > booked * cumulativeInvoice).toBe(true);
          });
          expect(cumulativeFreed).toBe(booked);
        },
      ),
    );
  });

  it('allocates a rebooked exposure over the remaining invoice and frees all of it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 6n }), { minLength: 2, maxLength: 20 }),
        fc.nat(),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        (slices, split, booked, rebookedOutstanding) => {
          const cut = 1 + (split % (slices.length - 1));
          const invoiceAmount = slices.reduce((sum, slice) => sum + slice, 0n);
          const start = reservation({ invoiceAmountMinor: invoiceAmount, bookedMinor: booked });
          const before = releaseInSlices(start, slices.slice(0, cut));
          const invoiceReleased = slices.slice(0, cut).reduce((sum, slice) => sum + slice, 0n);
          const released = before.reduce((sum, amount) => sum + amount, 0n);
          const rebooked = reservation({
            status: 'PARTIALLY_RELEASED',
            invoiceAmountMinor: invoiceAmount,
            invoiceReleasedMinor: invoiceReleased,
            bookedMinor: released + rebookedOutstanding,
            releasedMinor: released,
            allocationBase: { invoiceReleasedMinor: invoiceReleased, releasedMinor: released },
          });

          const after = releaseInSlices(rebooked, slices.slice(cut));

          const remainingInvoice = invoiceAmount - invoiceReleased;
          let cumulativeInvoice = 0n;
          let cumulativeFreed = 0n;
          after.forEach((amount, index) => {
            cumulativeInvoice += slices[cut + index]!;
            cumulativeFreed += amount;
            expect(
              cumulativeFreed * remainingInvoice <= rebookedOutstanding * cumulativeInvoice,
            ).toBe(true);
          });
          expect(cumulativeFreed).toBe(rebookedOutstanding);
        },
      ),
    );
  });

  it('never frees more than the proportional share before the final release', () => {
    const thirds = [1n, 1n, 1n];

    expect(releaseInSlices(reservation({ bookedMinor: 1_000n }), thirds)).toEqual([
      333n,
      333n,
      334n,
    ]);
    expect(releaseInSlices(reservation({ bookedMinor: 2n }), thirds)).toEqual([0n, 1n, 1n]);
  });
});
