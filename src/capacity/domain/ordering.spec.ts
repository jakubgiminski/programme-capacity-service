import { decideOrdering } from './ordering';

describe('decideOrdering', () => {
  it.each([
    [5n, 4n, 'DELTA', 'STALE'],
    [5n, 5n, 'DELTA', 'STALE'],
    [5n, 5n, 'SNAPSHOT', 'STALE'],
    [5n, 3n, 'SNAPSHOT', 'STALE'],
    [5n, 5n, 'INVALID', 'STALE'],
    [5n, 6n, 'DELTA', 'APPLY'],
    [0n, 1n, 'DELTA', 'APPLY'],
    [5n, 7n, 'DELTA', 'PARK'],
    [0n, 2n, 'DELTA', 'PARK'],
    [5n, 9n, 'SNAPSHOT', 'APPLY'],
    [5n, 6n, 'SNAPSHOT', 'APPLY'],
    [5n, 6n, 'INVALID', 'APPLY'],
    [5n, 9n, 'INVALID', 'APPLY'],
  ] as const)('current %p, incoming %p, %s => %p', (current, incoming, messageClass, expected) => {
    expect(decideOrdering(current, incoming, messageClass)).toBe(expected);
  });
});
