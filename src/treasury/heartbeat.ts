export interface Heartbeat {
  readonly failed: AbortSignal;
  settle(): Promise<void>;
  stop(): void;
}

export function startHeartbeat(beat: () => Promise<void>, intervalMs: number): Heartbeat {
  const failure = new AbortController();
  let inFlight: Promise<void> | null = null;
  const tick = () => {
    if (inFlight !== null) {
      return;
    }
    inFlight = beat()
      .catch((error: unknown) => {
        if (!failure.signal.aborted) {
          failure.abort(error instanceof Error ? error : new Error(String(error)));
        }
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  return {
    failed: failure.signal,
    settle: async () => {
      clearInterval(timer);
      await inFlight;
      if (failure.signal.aborted) {
        throw failure.signal.reason;
      }
    },
    stop: () => {
      clearInterval(timer);
    },
  };
}
