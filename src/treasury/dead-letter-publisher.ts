import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type IHeaders, type Kafka, Partitioners, type Producer } from 'kafkajs';
import {
  type MessageSource,
  TreasuryRepository,
} from '../capacity/infrastructure/treasury.repository';
import { type AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config.module';
import { DATABASE, type Db } from '../database/database';
import { type TreasuryDeadLettersTable } from '../database/database.types';
import { KAFKA } from './kafka-client';

const OUTBOX_BATCH = 100;
const FLUSH_INTERVAL_MS = 30_000;

type DeadLetterRow = Omit<TreasuryDeadLettersTable, 'id' | 'attempts' | 'created_at'> & {
  id: bigint;
};

export interface UnreadableMessage {
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly reason: string;
  readonly source: MessageSource;
}

function headers(row: DeadLetterRow): IHeaders {
  const result: IHeaders = {
    'x-dlq-reason': row.reason.slice(0, 1_000),
    'x-original-topic': row.source_topic,
    'x-original-partition': String(row.source_partition),
    'x-original-offset': row.source_offset,
  };
  if (row.message_id !== null) {
    result['x-message-id'] = row.message_id;
  }
  return result;
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

@Injectable()
export class DeadLetterPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DeadLetterPublisher.name);
  private readonly producer: Producer;
  private connected = false;
  private requested = false;
  private stopping = false;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KAFKA) kafka: Kafka,
    @Inject(DATABASE) private readonly db: Db,
    @Inject(TreasuryRepository) private readonly treasury: TreasuryRepository,
  ) {
    this.producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.notify();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref();
    this.notify();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
    }
    await this.running;
    if (this.connected) {
      await this.producer.disconnect();
    }
  }

  async recordUnreadable(message: UnreadableMessage): Promise<boolean> {
    return this.treasury.addDeadLetter(this.db, {
      messageId: null,
      programId: null,
      revision: null,
      reason: message.reason,
      key: message.key,
      payload: message.value,
      source: message.source,
    });
  }

  notify(): void {
    this.requested = true;
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
  }

  private async run(): Promise<void> {
    while (this.requested && !this.stopping) {
      this.requested = false;
      try {
        await this.publishPending();
      } catch (error) {
        this.logger.error({ err: error }, 'Failed to publish dead letters; will retry');
      }
    }
  }

  private async publishPending(): Promise<void> {
    let published = 0;
    for (;;) {
      const rows = await this.unpublished();
      if (rows.length === 0) {
        break;
      }
      if (!this.connected) {
        await this.producer.connect();
        this.connected = true;
      }
      const sent = await this.publishRows(rows);
      published += sent;
      if (rows.length < OUTBOX_BATCH || sent === 0 || this.stopping) {
        break;
      }
    }
    if (published > 0) {
      this.logger.log(`Published ${published} dead letters`);
    }
  }

  private unpublished(): Promise<DeadLetterRow[]> {
    return this.db
      .selectFrom('treasury_dead_letters')
      .select([
        'id',
        'message_id',
        'program_id',
        'revision',
        'reason',
        'message_key',
        'payload',
        'source_topic',
        'source_partition',
        'source_offset',
        'last_error',
        'published_at',
      ])
      .where('published_at', 'is', null)
      .orderBy('attempts')
      .orderBy('id')
      .limit(OUTBOX_BATCH)
      .execute();
  }

  private async publishRows(rows: readonly DeadLetterRow[]): Promise<number> {
    let published = 0;
    for (const row of rows) {
      try {
        await this.producer.send({
          topic: this.config.KAFKA_DLQ_TOPIC,
          acks: -1,
          messages: [{ key: row.message_key, value: row.payload, headers: headers(row) }],
        });
      } catch (error) {
        this.logger.error(
          { err: error, deadLetterId: String(row.id) },
          'Failed to publish dead letter; will retry',
        );
        await this.db
          .updateTable('treasury_dead_letters')
          .set((eb) => ({ attempts: eb('attempts', '+', 1), last_error: describeError(error) }))
          .where('id', '=', row.id)
          .execute();
        continue;
      }
      await this.db
        .updateTable('treasury_dead_letters')
        .set({ published_at: new Date(), last_error: null })
        .where('id', '=', row.id)
        .execute();
      published += 1;
    }
    return published;
  }
}
