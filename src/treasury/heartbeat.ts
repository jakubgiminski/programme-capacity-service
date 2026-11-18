export interface Heartbeat {
  settle(): Promise<void>;
  stop(): void;
}

export function startHeartbeat(beat: () => Promise<void>, intervalMs: number): Heartbeat {
  let failure: Error | null = null;
  let inFlight: Promise<void> | null = null;
  const tick = () => {
    if (inFlight !== null) {
      return;
    }
    inFlight = beat()
      .catch((error: unknown) => {
        failure ??= error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  return {
    settle: async () => {
      clearInterval(timer);
      await inFlight;
      if (failure !== null) {
        throw failure;
      }
    },
    stop: () => {
      clearInterval(timer);
    },
  };
}
