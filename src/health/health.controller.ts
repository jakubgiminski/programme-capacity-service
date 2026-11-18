import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'kysely';
import { Scope } from '../auth/principal';
import { RequireScope } from '../auth/require-scope.decorator';
import { DATABASE, type Db } from '../database/database';
import { ServiceUnavailableError } from '../http/problem';
import { KAFKA_HEALTH, type KafkaHealth } from '../treasury/kafka-health';

type CheckStatus = 'up' | 'down';

const DATABASE_TIMEOUT_MS = 2_000;

@Controller('health')
export class HealthController {
  private databaseProbe: Promise<CheckStatus> | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(KAFKA_HEALTH) private readonly kafka: KafkaHealth,
  ) {}

  @Get()
  @RequireScope(Scope.Read)
  async check() {
    const checks = { database: await this.checkDatabase(), kafka: this.kafka.status() };
    if (checks.database === 'down' || checks.kafka === 'down') {
      throw new ServiceUnavailableError('One or more dependencies are unavailable', { checks });
    }
    return { status: 'ok', checks };
  }

  private checkDatabase(): Promise<CheckStatus> {
    if (this.databaseProbe !== null) {
      return this.databaseProbe;
    }
    this.databaseProbe = this.probeDatabase().finally(() => {
      this.databaseProbe = null;
    });
    return this.databaseProbe;
  }

  private async probeDatabase(): Promise<CheckStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<CheckStatus>((resolve) => {
      timer = setTimeout(() => {
        resolve('down');
      }, DATABASE_TIMEOUT_MS);
    });
    const probe = sql`SELECT 1`
      .execute(this.db)
      .then((): CheckStatus => 'up')
      .catch((): CheckStatus => 'down');
    try {
      return await Promise.race([probe, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
