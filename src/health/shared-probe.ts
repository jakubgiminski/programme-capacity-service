export type ProbeStatus = 'up' | 'down';

export class SharedProbe {
  private inFlight: Promise<ProbeStatus> | null = null;

  constructor(
    private readonly run: () => Promise<unknown>,
    private readonly deadlineMs: number,
  ) {}

  async check(): Promise<ProbeStatus> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ProbeStatus>((resolve) => {
      timer = setTimeout(() => {
        resolve('down');
      }, this.deadlineMs);
    });
    try {
      return await Promise.race([this.shared(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private shared(): Promise<ProbeStatus> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    const probe = this.run()
      .then((): ProbeStatus => 'up')
      .catch((): ProbeStatus => 'down')
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = probe;
    return probe;
  }
}
