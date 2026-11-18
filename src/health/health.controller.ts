import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { type Response } from 'express';
import { sql } from 'kysely';
import { Scope } from '../auth/principal';
import { RequireScope } from '../auth/require-scope.decorator';
import { DATABASE, type Db } from '../database/database';
import { KAFKA_HEALTH, type KafkaHealth } from '../treasury/kafka-health';

type CheckStatus = 'up' | 'down';

const DATABASE_TIMEOUT_MS = 2_000;

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(KAFKA_HEALTH) private readonly kafka: KafkaHealth,
  ) {}

  @Get()
  @RequireScope(Scope.Read)
  async check(@Res({ passthrough: true }) response: Response) {
    const database = await this.checkDatabase();
    const kafka = this.kafka.status();
    const healthy = database === 'up' && kafka !== 'down';
    response.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: healthy ? 'ok' : 'unavailable', checks: { database, kafka } };
  }

  private async checkDatabase(): Promise<CheckStatus> {
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
