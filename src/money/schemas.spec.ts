import { moneySchema, nonNegativeMinorUnitsSchema } from './schemas';

describe('money schemas', () => {
  it('parses a money object into minor units and a currency code', () => {
    expect(moneySchema.parse({ amount: '1000000000', currency: 'USD' })).toEqual({
      amount: 1_000_000_000n,
      currency: 'USD',
    });
  });

  it.each([
    { amount: '0', currency: 'USD' },
    { amount: '-5', currency: 'USD' },
    { amount: '1.50', currency: 'USD' },
    { amount: 100, currency: 'USD' },
    { amount: '9223372036854775808', currency: 'USD' },
    { amount: '100000000000000000000', currency: 'USD' },
    { amount: '100', currency: 'usd' },
    { amount: '100', currency: 'USD', extra: 1 },
  ])('rejects %p', (input) => {
    expect(moneySchema.safeParse(input).success).toBe(false);
  });

  it('accepts zero for non-negative amounts', () => {
    expect(nonNegativeMinorUnitsSchema.parse('0')).toBe(0n);
    expect(nonNegativeMinorUnitsSchema.safeParse('-1').success).toBe(false);
  });
});
