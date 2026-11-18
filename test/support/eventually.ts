export async function eventually<T>(
  probe: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await probe();
  while (!accept(last)) {
    if (Date.now() > deadline) {
      throw new Error(`Condition not met within ${timeoutMs}ms; last value: ${stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await probe();
  }
  return last;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}
