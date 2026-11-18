export type KafkaStatus = 'up' | 'down' | 'disabled';

export const KAFKA_HEALTH = Symbol('KAFKA_HEALTH');

export class KafkaHealth {
  private current: KafkaStatus;

  constructor(enabled: boolean) {
    this.current = enabled ? 'down' : 'disabled';
  }

  status(): KafkaStatus {
    return this.current;
  }

  markUp(): void {
    this.current = 'up';
  }

  markDown(): void {
    if (this.current === 'disabled') {
      return;
    }
    this.current = 'down';
  }
}
