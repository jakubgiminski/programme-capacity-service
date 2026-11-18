import { startHeartbeat } from './heartbeat';

describe('startHeartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('beats on every interval and settles cleanly', async () => {
    const beat = jest.fn(() => Promise.resolve());
    const heartbeat = startHeartbeat(beat, 1_000);

    await jest.advanceTimersByTimeAsync(3_000);
    await heartbeat.settle();
    await jest.advanceTimersByTimeAsync(3_000);

    expect(beat).toHaveBeenCalledTimes(3);
  });

  it('never overlaps beats and waits for the one in flight before settling', async () => {
    let fail: (error: Error) => void = () => undefined;
    const beat = jest.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const heartbeat = startHeartbeat(beat, 1_000);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(beat).toHaveBeenCalledTimes(1);

    const settled = heartbeat.settle();
    fail(new Error('rebalance in progress'));

    await expect(settled).rejects.toThrow('rebalance in progress');
  });

  it('signals the first failure so in-flight work can stop retrying', async () => {
    const beat = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('rebalance in progress'))
      .mockRejectedValue(new Error('later failure'));
    const heartbeat = startHeartbeat(beat, 1_000);
    expect(heartbeat.failed.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(2_000);

    expect(heartbeat.failed.aborted).toBe(true);
    expect(heartbeat.failed.reason).toEqual(new Error('rebalance in progress'));
    heartbeat.stop();
  });
});
