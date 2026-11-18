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
import { KAFKA } from './kafka-client';
import { KAFKA_HEALTH, type KafkaHealth } from './kafka-health';
import { parseTreasuryMessage } from './treasury-messages';

const INITIAL_BACKOFF_MS = 200;
const OUTBOX_FLUSH_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 3_000;

interface Heartbeat {
  assertAlive(): void;
  stop(): void;
}

@Injectable()
export class TreasuryConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TreasuryConsumer.name);
  private readonly consumer: Consumer;
  private readonly shutdown = new AbortController();
  private starting: Promise<void> | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;

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
    if (this.outboxTimer !== null) {
      clearInterval(this.outboxTimer);
    }
    await this.starting;
    await this.consumer.disconnect();
    await this.deadLetters.disconnect();
    this.health.markDown();
  }

  whenStarted(): Promise<void> {
    return this.starting ?? Promise.resolve();
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
        const proceed = await this.pause(delay);
        if (!proceed) {
          return;
        }
        delay = Math.min(delay * 2, this.config.KAFKA_RETRY_MAX_BACKOFF_MS);
      }
    }
  }

  private async start(): Promise<void> {
    await this.ensureTopics();
    await this.deadLetters.connect();
    await this.flushOutbox();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.config.KAFKA_TOPIC, fromBeginning: true });
    await this.consumer.run({
      autoCommit: false,
      partitionsConsumedConcurrently: this.config.KAFKA_PARTITIONS_CONSUMED_CONCURRENTLY,
      eachMessage: (payload) => this.handle(payload),
    });
    this.outboxTimer = setInterval(() => {
      void this.flushOutbox();
    }, OUTBOX_FLUSH_INTERVAL_MS);
    this.outboxTimer.unref();
  }

  private async ensureTopics(): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const existing = new Set(await admin.listTopics());
      const missing = [this.config.KAFKA_TOPIC, this.config.KAFKA_DLQ_TOPIC]
        .filter((topic) => !existing.has(topic))
        .map((topic) => ({ topic, numPartitions: this.config.KAFKA_TOPIC_PARTITIONS }));
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
    const heartbeat = this.keepAlive(payload);
    try {
      await this.processWithRetry(message, source);
      heartbeat.assertAlive();
    } finally {
      heartbeat.stop();
    }
    await this.consumer.commitOffsets([
      { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
    ]);
  }

  private keepAlive(payload: EachMessagePayload): Heartbeat {
    let failure: Error | null = null;
    const timer = setInterval(() => {
      payload.heartbeat().catch((error: unknown) => {
        failure ??= error instanceof Error ? error : new Error(String(error));
      });
    }, HEARTBEAT_INTERVAL_MS);
    return {
      assertAlive: () => {
        if (failure !== null) {
          throw failure;
        }
      },
      stop: () => {
        clearInterval(timer);
      },
    };
  }

  private async processWithRetry(message: KafkaMessage, source: MessageSource): Promise<void> {
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
        const proceed = await this.pause(delay);
        if (!proceed) {
          throw error;
        }
        delay = Math.min(delay * 2, this.config.KAFKA_RETRY_MAX_BACKOFF_MS);
      }
    }
  }

  private async process(message: KafkaMessage, source: MessageSource): Promise<void> {
    const value = message.value ?? Buffer.alloc(0);
    const rawValue = value.toString('utf8');
    const parsed = parseTreasuryMessage(rawValue);
    if (parsed.kind === 'unreadable') {
      await this.deadLetterUnreadable(message, value, source, parsed.reason);
      return;
    }
    const key = message.key?.toString('utf8') ?? null;
    if (key !== parsed.envelope.programId) {
      const reason = `Message key ${JSON.stringify(key)} does not match programId ${parsed.envelope.programId}`;
      await this.deadLetterUnreadable(message, value, source, reason);
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
      await this.flushOutbox();
    }
  }

  private async deadLetterUnreadable(
    message: KafkaMessage,
    value: Buffer,
    source: MessageSource,
    reason: string,
  ): Promise<void> {
    const recorded = await this.deadLetters.recordUnreadable({
      key: message.key,
      value,
      reason,
      source,
    });
    this.logger.warn({ ...source, reason, recorded }, 'Unreadable treasury message dead-lettered');
    await this.flushOutbox();
  }

  private async flushOutbox(): Promise<void> {
    try {
      await this.deadLetters.flushOutbox();
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to flush dead-letter outbox; will retry');
    }
  }

  private async pause(ms: number): Promise<boolean> {
    try {
      await sleep(ms, undefined, { signal: this.shutdown.signal });
      return true;
    } catch {
      return false;
    }
  }
}
