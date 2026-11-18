import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'kysely';
import { Scope } from '../auth/principal';
import { RequireScope } from '../auth/require-scope.decorator';
import { DATABASE, type Db } from '../database/database';
import { ServiceUnavailableError } from '../http/problem';
import { KAFKA_HEALTH, type KafkaHealth } from '../treasury/kafka-health';
import { SharedProbe } from './shared-probe';

const DATABASE_DEADLINE_MS = 2_000;

@Controller('health')
export class HealthController {
  private readonly database: SharedProbe;

  constructor(
    @Inject(DATABASE) db: Db,
    @Inject(KAFKA_HEALTH) private readonly kafka: KafkaHealth,
  ) {
    this.database = new SharedProbe(() => sql`SELECT 1`.execute(db), DATABASE_DEADLINE_MS);
  }

  @Get()
  @RequireScope(Scope.Read)
  async check() {
    const checks = { database: await this.database.check(), kafka: this.kafka.status() };
    if (checks.database === 'down' || checks.kafka === 'down') {
      throw new ServiceUnavailableError('One or more dependencies are unavailable', { checks });
    }
    return { status: 'ok', checks };
  }
}
