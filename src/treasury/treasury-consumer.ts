import { setTimeout as sleep } from 'node:timers/promises';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type Consumer, type EachMessagePayload, type Kafka, type KafkaMessage } from 'kafkajs';
import { ApplyTreasuryMessage } from '../capacity/application/apply-treasury-message';
import { type MessageSource } from '../capacity/infrastructure/treasury.repository';
import { type AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config.module';
import { DeadLetterPublisher } from './dead-letter-publisher';
import { startHeartbeat } from './heartbeat';
import { KAFKA } from './kafka-client';
import { KAFKA_HEALTH, type KafkaHealth } from './kafka-health';
import { parseTreasuryMessage } from './treasury-messages';

const INITIAL_BACKOFF_MS = 200;
const HEARTBEAT_INTERVAL_MS = 3_000;

export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeValue(value: Buffer | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    return strictUtf8.decode(value);
  } catch {
    return null;
  }
}

@Injectable()
export class TreasuryConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TreasuryConsumer.name);
  private readonly consumer: Consumer;
  private readonly shutdown = new AbortController();
  private starting: Promise<void> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KAFKA) private readonly kafka: Kafka,
    @Inject(KAFKA_HEALTH) private readonly health: KafkaHealth,
    @Inject(ApplyTreasuryMessage) private readonly applyMessage: ApplyTreasuryMessage,
    @Inject(DeadLetterPublisher) private readonly deadLetters: DeadLetterPublisher,
  ) {
    this.consumer = kafka.consumer({
      groupId: config.KAFKA_GROUP_ID,
      allowAutoTopicCreation: false,
      maxBytesPerPartition: MAX_MESSAGE_BYTES,
      maxBytes: 2 * MAX_MESSAGE_BYTES,
    });
    this.consumer.on(this.consumer.events.GROUP_JOIN, () => {
      this.health.markUp();
    });
    this.consumer.on(this.consumer.events.CRASH, () => {
      this.health.markDown();
    });
    this.consumer.on(this.consumer.events.DISCONNECT, () => {
      this.health.markDown();
    });
    this.consumer.on(this.consumer.events.STOP, () => {
      this.health.markDown();
    });
  }

  onApplicationBootstrap(): void {
    this.starting = this.startWithRetry();
  }

  async onApplicationShutdown(): Promise<void> {
    this.shutdown.abort();
    await this.starting;
    await this.consumer.disconnect();
    this.health.markDown();
  }

  private async startWithRetry(): Promise<void> {
    let delay = INITIAL_BACKOFF_MS;
    while (!this.shutdown.signal.aborted) {
      try {
        await this.start();
        return;
      } catch (error) {
        this.logger.error({ err: error }, 'Failed to start treasury consumer, retrying');
        this.health.markDown();
        const proceed = await this.pause(delay, this.shutdown.signal);
        if (!proceed) {
          return;
        }
        delay = Math.min(delay * 2, this.config.KAFKA_RETRY_MAX_BACKOFF_MS);
      }
    }
  }

  private async start(): Promise<void> {
    if (this.config.KAFKA_CREATE_TOPICS) {
      await this.ensureTopics();
    }
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.config.KAFKA_TOPIC, fromBeginning: true });
    await this.consumer.run({
      autoCommit: false,
      partitionsConsumedConcurrently: this.config.KAFKA_PARTITIONS_CONSUMED_CONCURRENTLY,
      eachMessage: (payload) => this.handle(payload),
    });
  }

  private async ensureTopics(): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const existing = new Set(await admin.listTopics());
      const missing = [this.config.KAFKA_TOPIC, this.config.KAFKA_DLQ_TOPIC]
        .filter((topic) => !existing.has(topic))
        .map((topic) => ({
          topic,
          numPartitions: this.config.KAFKA_TOPIC_PARTITIONS,
          configEntries: [{ name: 'max.message.bytes', value: String(MAX_MESSAGE_BYTES) }],
        }));
      if (missing.length > 0) {
        await admin.createTopics({ waitForLeaders: true, topics: missing });
      }
    } finally {
      await admin.disconnect();
    }
  }

  private async handle(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    const source: MessageSource = { topic, partition, offset: message.offset };
    const heartbeat = startHeartbeat(() => payload.heartbeat(), HEARTBEAT_INTERVAL_MS);
    try {
      await this.processWithRetry(message, source, heartbeat.failed);
    } finally {
      heartbeat.stop();
    }
    await heartbeat.settle();
    await this.consumer.commitOffsets([
      { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
    ]);
  }

  private async processWithRetry(
    message: KafkaMessage,
    source: MessageSource,
    assignmentLost: AbortSignal,
  ): Promise<void> {
    const stop = AbortSignal.any([this.shutdown.signal, assignmentLost]);
    let delay = INITIAL_BACKOFF_MS;
    for (;;) {
      try {
        await this.process(message, source);
        return;
      } catch (error) {
        this.logger.error(
          { err: error, ...source },
          'Failed to process treasury message, retrying without committing',
        );
        const proceed = await this.pause(delay, stop);
        if (!proceed) {
          throw error;
        }
        delay = Math.min(delay * 2, this.config.KAFKA_RETRY_MAX_BACKOFF_MS);
      }
    }
  }

  private async process(message: KafkaMessage, source: MessageSource): Promise<void> {
    const rawValue = decodeValue(message.value);
    if (rawValue === null) {
      const reason =
        message.value === null ? 'Message has no value' : 'Message value is not valid UTF-8';
      await this.deadLetterUnreadable(message, source, reason);
      return;
    }
    const parsed = parseTreasuryMessage(rawValue);
    if (parsed.kind === 'unreadable') {
      await this.deadLetterUnreadable(message, source, parsed.reason);
      return;
    }
    const key = message.key?.toString('utf8') ?? null;
    if (key !== parsed.envelope.programId) {
      const reason = `Message key ${JSON.stringify(key)} does not match programId ${parsed.envelope.programId}`;
      await this.deadLetterUnreadable(message, source, reason);
      return;
    }
    const result = await this.applyMessage.execute({ parsed, rawValue, source });
    this.logger.log(
      {
        ...source,
        messageId: parsed.envelope.messageId,
        programId: parsed.envelope.programId,
        revision: parsed.envelope.revision,
        type: parsed.envelope.type,
        outcome: result.outcome,
        reason: result.reason,
        drained: result.drained,
      },
      'Treasury message handled',
    );
    if (result.deadLettered > 0) {
      this.deadLetters.notify();
    }
  }

  private async deadLetterUnreadable(
    message: KafkaMessage,
    source: MessageSource,
    reason: string,
  ): Promise<void> {
    const recorded = await this.deadLetters.recordUnreadable({
      key: message.key,
      value: message.value,
      reason,
      source,
    });
    this.logger.warn({ ...source, reason, recorded }, 'Unreadable treasury message dead-lettered');
    this.deadLetters.notify();
  }

  private async pause(ms: number, signal: AbortSignal): Promise<boolean> {
    try {
      await sleep(ms, undefined, { signal });
      return true;
    } catch {
      return false;
    }
  }
}
