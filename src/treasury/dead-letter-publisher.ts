import { Inject, Injectable, Logger } from '@nestjs/common';
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

type DeadLetterRow = Omit<TreasuryDeadLettersTable, 'id' | 'attempts' | 'created_at'> & {
  id: bigint;
};

export interface UnreadableMessage {
  readonly key: Buffer | null;
  readonly value: Buffer;
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
export class DeadLetterPublisher {
  private readonly logger = new Logger(DeadLetterPublisher.name);
  private readonly producer: Producer;
  private flushing: Promise<number> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KAFKA) kafka: Kafka,
    @Inject(DATABASE) private readonly db: Db,
    @Inject(TreasuryRepository) private readonly treasury: TreasuryRepository,
  ) {
    this.producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
  }

  async connect(): Promise<void> {
    await this.producer.connect();
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
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

  flushOutbox(): Promise<number> {
    if (this.flushing !== null) {
      return this.flushing;
    }
    this.flushing = this.drainOutbox().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drainOutbox(): Promise<number> {
    let published = 0;
    for (;;) {
      const batch = await this.publishBatch();
      published += batch.published;
      if (batch.selected < OUTBOX_BATCH || batch.published === 0) {
        if (published > 0) {
          this.logger.log(`Published ${published} dead letters`);
        }
        return published;
      }
    }
  }

  private publishBatch(): Promise<{ selected: number; published: number }> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
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
        .forUpdate()
        .skipLocked()
        .execute();
      let published = 0;
      for (const row of rows) {
        try {
          await this.publish(row);
          await trx
            .updateTable('treasury_dead_letters')
            .set({ published_at: new Date(), last_error: null })
            .where('id', '=', row.id)
            .execute();
          published += 1;
        } catch (error) {
          this.logger.error(
            { err: error, deadLetterId: String(row.id) },
            'Failed to publish dead letter; will retry',
          );
          await trx
            .updateTable('treasury_dead_letters')
            .set((eb) => ({ attempts: eb('attempts', '+', 1), last_error: describeError(error) }))
            .where('id', '=', row.id)
            .execute();
        }
      }
      return { selected: rows.length, published };
    });
  }

  private async publish(row: DeadLetterRow): Promise<void> {
    await this.producer.send({
      topic: this.config.KAFKA_DLQ_TOPIC,
      acks: -1,
      messages: [{ key: row.message_key, value: row.payload, headers: headers(row) }],
    });
  }
}
