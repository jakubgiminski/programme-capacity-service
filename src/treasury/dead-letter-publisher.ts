import { Inject, Injectable, Logger } from '@nestjs/common';
import { type IHeaders, type Kafka, Partitioners, type Producer } from 'kafkajs';
import { type MessageSource } from '../capacity/infrastructure/treasury.repository';
import { type AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config.module';
import { DATABASE, type Db } from '../database/database';
import { KAFKA } from './kafka-client';

const OUTBOX_BATCH = 100;

export interface DirectDeadLetter {
  readonly key: Buffer | null;
  readonly rawValue: string;
  readonly reason: string;
  readonly source: MessageSource;
}

function headers(reason: string, source: MessageSource, messageId: string | null): IHeaders {
  const result: IHeaders = {
    'x-dlq-reason': reason.slice(0, 1_000),
    'x-original-topic': source.topic,
    'x-original-partition': String(source.partition),
    'x-original-offset': source.offset,
  };
  if (messageId !== null) {
    result['x-message-id'] = messageId;
  }
  return result;
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
  ) {
    this.producer = kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
      createPartitioner: Partitioners.DefaultPartitioner,
    });
  }

  async connect(): Promise<void> {
    await this.producer.connect();
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
  }

  async publishDirect(deadLetter: DirectDeadLetter): Promise<void> {
    await this.producer.send({
      topic: this.config.KAFKA_DLQ_TOPIC,
      acks: -1,
      messages: [
        {
          key: deadLetter.key,
          value: deadLetter.rawValue,
          headers: headers(deadLetter.reason, deadLetter.source, null),
        },
      ],
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
      published += batch;
      if (batch < OUTBOX_BATCH) {
        if (published > 0) {
          this.logger.log(`Published ${published} dead letters`);
        }
        return published;
      }
    }
  }

  private publishBatch(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('treasury_dead_letters')
        .selectAll()
        .where('published_at', 'is', null)
        .orderBy('id')
        .limit(OUTBOX_BATCH)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) {
        return 0;
      }
      await this.producer.send({
        topic: this.config.KAFKA_DLQ_TOPIC,
        acks: -1,
        messages: rows.map((row) => ({
          key: row.program_id,
          value: row.raw_value,
          headers: headers(
            row.reason,
            { topic: row.source_topic, partition: row.source_partition, offset: row.source_offset },
            row.message_id,
          ),
        })),
      });
      await trx
        .updateTable('treasury_dead_letters')
        .set({ published_at: new Date() })
        .where(
          'id',
          'in',
          rows.map((row) => row.id),
        )
        .execute();
      return rows.length;
    });
  }
}
