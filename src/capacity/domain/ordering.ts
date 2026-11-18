export type OrderingDecision = 'STALE' | 'APPLY' | 'PARK';

export type MessageClass = 'DELTA' | 'SNAPSHOT' | 'INVALID';

export function decideOrdering(
  currentRevision: bigint,
  revision: bigint,
  messageClass: MessageClass,
): OrderingDecision {
  if (revision <= currentRevision) {
    return 'STALE';
  }
  if (messageClass === 'DELTA' && revision > currentRevision + 1n) {
    return 'PARK';
  }
  return 'APPLY';
}
