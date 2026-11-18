import { decideOrdering } from './ordering';

describe('decideOrdering', () => {
  it.each([
    [5n, 4n, false, 'STALE'],
    [5n, 5n, false, 'STALE'],
    [5n, 5n, true, 'STALE'],
    [5n, 3n, true, 'STALE'],
    [5n, 6n, false, 'APPLY'],
    [0n, 1n, false, 'APPLY'],
    [5n, 7n, false, 'PARK'],
    [0n, 2n, false, 'PARK'],
    [5n, 9n, true, 'APPLY'],
    [5n, 6n, true, 'APPLY'],
  ] as const)(
    'current %p, incoming %p, valid snapshot %p => %p',
    (current, incoming, snapshot, expected) => {
      expect(decideOrdering(current, incoming, snapshot)).toBe(expected);
    },
  );
});
