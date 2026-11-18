import { SharedProbe } from './shared-probe';

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('SharedProbe', () => {
  it('reports up when the probe succeeds and down when it fails', async () => {
    await expect(new SharedProbe(() => Promise.resolve(), 1_000).check()).resolves.toBe('up');
    await expect(
      new SharedProbe(() => Promise.reject(new Error('boom')), 1_000).check(),
    ).resolves.toBe('down');
  });

  it('keeps one probe in flight past the deadline and starts a new one once it settles', async () => {
    const pending = deferred();
    const run = jest.fn(() => pending.promise);
    const probe = new SharedProbe(run, 20);

    const first = await probe.check();
    const second = await probe.check();
    expect([first, second]).toEqual(['down', 'down']);
    expect(run).toHaveBeenCalledTimes(1);

    pending.resolve();
    await pending.promise;
    await new Promise((resolve) => setImmediate(resolve));
    run.mockImplementation(() => Promise.resolve());

    await expect(probe.check()).resolves.toBe('up');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('shares one probe between concurrent checks', async () => {
    const pending = deferred();
    const run = jest.fn(() => pending.promise);
    const probe = new SharedProbe(run, 1_000);

    const checks = Promise.all([probe.check(), probe.check(), probe.check()]);
    pending.resolve();

    await expect(checks).resolves.toEqual(['up', 'up', 'up']);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
