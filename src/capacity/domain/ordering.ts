export type OrderingDecision = 'STALE' | 'APPLY' | 'PARK';

export function decideOrdering(
  currentRevision: bigint,
  revision: bigint,
  isValidSnapshot: boolean,
): OrderingDecision {
  if (revision <= currentRevision) {
    return 'STALE';
  }
  if (isValidSnapshot) {
    return 'APPLY';
  }
  if (revision === currentRevision + 1n) {
    return 'APPLY';
  }
  return 'PARK';
}
