import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { RedpandaContainer, type StartedRedpandaContainer } from '@testcontainers/redpanda';
import {
  type Admin,
  type Consumer,
  type IHeaders,
  Kafka,
  logLevel,
  type Message,
  Partitioners,
  type Producer,
} from 'kafkajs';
import { KAFKA_HEALTH, type KafkaHealth } from '../../src/treasury/kafka-health';
import { TreasuryConsumer } from '../../src/treasury/treasury-consumer';
import { MAX_SNAPSHOT_RESERVATIONS } from '../../src/treasury/treasury-messages';
import { programState } from '../support/capacity-fixture';
import { eventually } from '../support/eventually';
import { createTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase, withAdminClient } from '../support/test-database';
import { invoiceRepaid, limitSet, snapshot } from '../support/treasury-messages';

interface DeadLetterRecord {
  value: Buffer | null;
  text: string;
  headers: Record<string, string>;
}

describe('Treasury Kafka consumer (Redpanda)', () => {
  let redpanda: StartedRedpandaContainer;
  let kafka: Kafka;
  let admin: Admin;
  let producer: Producer;
  let database: TestDatabase;
  let app: TestApp | null = null;
  let topic: string;
  let dlqTopic: string;
  let groupId: string;
  let produced: Map<number, bigint>;

  async function startApp(): Promise<TestApp> {
    const started = await createTestApp(database, {
      KAFKA_ENABLED: 'true',
      KAFKA_BROKERS: redpanda.getBootstrapServers(),
      KAFKA_TOPIC: topic,
      KAFKA_DLQ_TOPIC: dlqTopic,
      KAFKA_GROUP_ID: groupId,
      KAFKA_TOPIC_PARTITIONS: '3',
      KAFKA_RETRY_MAX_BACKOFF_MS: '500',
    });
    const health = started.app.get<KafkaHealth>(KAFKA_HEALTH);
    await eventually(
      () => Promise.resolve(health.status()),
      (status) => status === 'up',
      30_000,
    );
    app = started;
    return started;
  }

  async function stopApp(): Promise<void> {
    await app?.close();
    app = null;
  }

  async function send(message: Message): Promise<void> {
    const [metadata] = await producer.send({ topic, acks: -1, messages: [message] });
    const next = BigInt(metadata!.baseOffset!) + 1n;
    produced.set(metadata!.partition, next);
  }

  async function produce(
    messages: (Record<string, unknown> | string)[],
    key = 'PRG',
  ): Promise<void> {
    for (const message of messages) {
      const value = typeof message === 'string' ? message : JSON.stringify(message);
      const programId =
        typeof message === 'string' ? key : ((message.programId as string | undefined) ?? key);
      await send({ key: programId, value });
    }
  }

  async function committedOffsets(): Promise<Map<number, bigint>> {
    const offsets = await admin.fetchOffsets({ groupId, topics: [topic] });
    return new Map(
      offsets
        .flatMap((entry) => entry.partitions)
        .filter((partition) => Number(partition.offset) >= 0)
        .map((partition) => [partition.partition, BigInt(partition.offset)]),
    );
  }

  async function allCommitted(timeoutMs = 20_000): Promise<void> {
    const expected = [...produced.entries()].sort(([a], [b]) => a - b);
    await eventually(
      committedOffsets,
      (offsets) =>
        expected.every(([partition, offset]) => offsets.get(partition) === offset) &&
        offsets.size === expected.length,
      timeoutMs,
    );
  }

  async function processedCount(programId: string): Promise<number> {
    const rows = await database.db
      .selectFrom('processed_messages')
      .select('message_id')
      .where('program_id', '=', programId)
      .execute();
    return rows.length;
  }

  async function readDeadLetters(expected: number): Promise<DeadLetterRecord[]> {
    const records: DeadLetterRecord[] = [];
    const consumer = kafka.consumer({ groupId: `dlq-reader-${randomUUID()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: dlqTopic, fromBeginning: true });
    await consumer.run({
      eachMessage: ({ message }) => {
        records.push({
          value: message.value,
          text: message.value?.toString('utf8') ?? '',
          headers: decodeHeaders(message.headers),
        });
        return Promise.resolve();
      },
    });
    try {
      await eventually(
        () => Promise.resolve(records.length),
        (count) => count >= expected,
        20_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      return [...records];
    } finally {
      await consumer.disconnect();
    }
  }

  beforeAll(async () => {
    redpanda = await new RedpandaContainer(
      'docker.redpanda.com/redpandadata/redpanda:v26.1.20',
    ).start();
    kafka = new Kafka({
      clientId: 'test-client',
      brokers: [redpanda.getBootstrapServers()],
      logLevel: logLevel.NOTHING,
    });
    admin = kafka.admin();
    await admin.connect();
    producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
    await producer.connect();
  }, 120_000);

  afterAll(async () => {
    await producer.disconnect();
    await admin.disconnect();
    await redpanda.stop();
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    topic = `treasury.test.${suffix}`;
    dlqTopic = `${topic}.dlq`;
    groupId = `capacity-${suffix}`;
    produced = new Map();
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await stopApp();
    await database.destroy();
  });

  it('treats a replay of already processed messages from offset zero as a no-op', async () => {
    const id = 'PRG-K-REPLAY';
    const stream = [
      limitSet(`${id}-1`, id, 1, '100000'),
      snapshot(`${id}-2`, id, 2, '90000', [
        { invoiceId: 'A', invoiceAmount: '100', invoiceCurrency: 'USD', bookedAmount: '100' },
      ]),
      '{not json',
      invoiceRepaid(`${id}-3`, id, 3, 'A', 'TR-1', { amount: '40', currency: 'USD' }),
      invoiceRepaid(`${id}-4`, id, 4, 'MISSING', 'TR-2'),
      limitSet(`${id}-5`, id, 5, '80000'),
    ];
    await startApp();
    await produce(stream, id);
    await allCommitted();
    const before = await programState(database.db, id);
    expect(before).toMatchObject({ limitMinor: 80_000n, utilisedMinor: 60n });
    expect(await readDeadLetters(2)).toHaveLength(2);
    await stopApp();

    await admin.resetOffsets({ groupId, topic, earliest: true });
    expect([...(await committedOffsets()).values()].every((offset) => offset === 0n)).toBe(true);
    await startApp();
    await allCommitted();

    expect(await programState(database.db, id)).toEqual(before);
    expect(await processedCount(id)).toBe(stream.length - 1);
    expect(await readDeadLetters(2)).toHaveLength(2);
  });

  it('parks a revision gap, drains it, and ignores a stale snapshot', async () => {
    const id = 'PRG-K-ORDER';
    await startApp();

    await produce([limitSet(`${id}-1`, id, 1, '1000'), limitSet(`${id}-3`, id, 3, '3000')]);
    await allCommitted();
    expect((await programState(database.db, id)).limitMinor).toBe(1_000n);

    await produce([limitSet(`${id}-2`, id, 2, '2000'), snapshot(`${id}-stale`, id, 2, '1', [])]);
    await allCommitted();

    expect((await programState(database.db, id)).limitMinor).toBe(3_000n);
    const stream = await database.db
      .selectFrom('treasury_streams')
      .select('revision')
      .where('program_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(stream.revision).toBe(3n);
    const stale = await database.db
      .selectFrom('processed_messages')
      .select('outcome')
      .where('message_id', '=', `${id}-stale`)
      .executeTakeFirstOrThrow();
    expect(stale.outcome).toBe('STALE');
  });

  it('routes poison and rejected messages to the DLQ and keeps consuming', async () => {
    const id = 'PRG-K-POISON';
    await startApp();

    await produce(['{not json', JSON.stringify({ hello: 'world' })], id);
    await send({ key: 'PRG-OTHER', value: JSON.stringify(limitSet(`${id}-x`, id, 1, '1')) });
    await produce([
      limitSet(`${id}-1`, id, 1, '1000'),
      limitSet(`${id}-2`, id, 2, '2000', 'EUR'),
      limitSet(`${id}-3`, id, 3, '3000'),
    ]);
    await allCommitted();

    expect((await programState(database.db, id)).limitMinor).toBe(3_000n);
    const deadLetters = await readDeadLetters(4);
    expect(deadLetters).toHaveLength(4);
    expect(
      deadLetters.find((record) => record.headers['x-dlq-reason']?.includes('does not match')),
    ).toBeDefined();
    expect(deadLetters.map((record) => record.text)).toEqual(
      expect.arrayContaining(['{not json', JSON.stringify({ hello: 'world' })]),
    );
    const rejected = deadLetters.find((record) => record.headers['x-message-id'] === `${id}-2`);
    expect(rejected?.headers).toMatchObject({
      'x-original-topic': topic,
      'x-dlq-reason': expect.stringMatching(/currency/) as unknown,
    });
    const unreadable = deadLetters.find((record) => record.text === '{not json');
    expect(unreadable?.headers).toMatchObject({
      'x-original-topic': topic,
      'x-original-partition': expect.any(String) as unknown,
      'x-original-offset': expect.any(String) as unknown,
      'x-dlq-reason': 'Message value is not valid JSON',
    });
    const outbox = await database.db
      .selectFrom('treasury_dead_letters')
      .select(['message_id', 'source_partition', 'source_offset', 'published_at'])
      .execute();
    const sources = deadLetters.map((record) => ({
      partition: Number(record.headers['x-original-partition']),
      offset: record.headers['x-original-offset'],
    }));
    expect(outbox).toHaveLength(4);
    expect(outbox.filter((row) => row.message_id !== null)).toEqual([
      expect.objectContaining({ message_id: `${id}-2` }),
    ]);
    for (const row of outbox) {
      expect(row.published_at).toBeInstanceOf(Date);
      expect(sources).toContainEqual({
        partition: row.source_partition,
        offset: row.source_offset,
      });
    }
  });

  it('dead-letters the exact original bytes, including tombstones and invalid UTF-8', async () => {
    const id = 'PRG-K-BYTES';
    const semantic = Buffer.from(
      `{ "messageId":"${id}-1", "programId":"${id}", "revision":1,\n  "type":"ProgramLimitSet", "occurredAt":"2026-11-18T10:00:00Z", "currency":"USD", "limit":"１００" }`,
      'utf8',
    );
    const invalidUtf8 = Buffer.concat([
      Buffer.from(`{"messageId":"${id}-2","programId":"${id}","note":"`, 'utf8'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}', 'utf8'),
    ]);
    await startApp();

    await send({ key: id, value: semantic });
    await send({ key: id, value: invalidUtf8 });
    await send({ key: id, value: null });
    await allCommitted();

    const deadLetters = await readDeadLetters(3);
    const byReason = (pattern: RegExp) =>
      deadLetters.find((record) => pattern.test(record.headers['x-dlq-reason'] ?? ''));
    expect(byReason(/Invalid ProgramLimitSet/)?.value).toEqual(semantic);
    expect(byReason(/not valid UTF-8/)?.value).toEqual(invalidUtf8);
    expect(byReason(/no value/)?.value).toBeNull();
  });

  it('applies a message exactly once when committing its offset fails', async () => {
    const id = 'PRG-K-COMMIT';
    const started = await startApp();
    const treasuryConsumer: unknown = started.app.get(TreasuryConsumer);
    const { consumer } = treasuryConsumer as { consumer: Consumer };
    const commit = jest
      .spyOn(consumer, 'commitOffsets')
      .mockRejectedValueOnce(new Error('broker unavailable'));

    await produce([limitSet(`${id}-1`, id, 1, '1000')]);
    await allCommitted(30_000);

    expect(commit.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await programState(database.db, id)).toMatchObject({
      limitMinor: 1_000n,
      ledgerEntries: 1,
    });
    expect(await processedCount(id)).toBe(1);
    commit.mockRestore();
  });

  it(`consumes a snapshot with the maximum ${MAX_SNAPSHOT_RESERVATIONS} reservations`, async () => {
    const id = 'PRG-K-BULK';
    const reservations = Array.from({ length: MAX_SNAPSHOT_RESERVATIONS }, (_, index) => ({
      invoiceId: `INV-${String(index).padStart(60, '0')}`,
      invoiceAmount: '999999999999',
      invoiceCurrency: 'USD',
      outstandingInvoiceAmount: '999999999999',
      bookedAmount: '999999999999',
    }));
    const message = snapshot(`${id}-1`, id, 1, '9000000000000000000', reservations);
    const bytes = Buffer.byteLength(JSON.stringify(message));
    await startApp();

    await produce([message]);
    await allCommitted(120_000);

    expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(await programState(database.db, id)).toMatchObject({
      reservations: MAX_SNAPSHOT_RESERVATIONS,
      utilisedMinor: 999_999_999_999n * BigInt(MAX_SNAPSHOT_RESERVATIONS),
    });
  }, 180_000);

  it('does not commit the offset while the database is unavailable', async () => {
    const id = 'PRG-K-OUTAGE';
    await startApp();
    await produce([limitSet(`${id}-1`, id, 1, '1000')]);
    await allCommitted();
    const beforeOutage = await committedOffsets();

    await withAdminClient(async (client) => {
      await client.query(`ALTER DATABASE "${database.name}" ALLOW_CONNECTIONS false`);
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [database.name],
      );
    });
    const failures = jest.spyOn(Logger.prototype, 'error');
    await produce([limitSet(`${id}-2`, id, 2, '2000')]);
    await eventually(
      () =>
        Promise.resolve(
          failures.mock.calls.filter((call) =>
            String(call[1]).startsWith('Failed to process treasury message'),
          ).length,
        ),
      (count) => count >= 2,
      30_000,
    );
    expect(await committedOffsets()).toEqual(beforeOutage);
    failures.mockRestore();

    await withAdminClient((client) =>
      client.query(`ALTER DATABASE "${database.name}" ALLOW_CONNECTIONS true`),
    );
    await allCommitted(30_000);
    expect((await programState(database.db, id)).limitMinor).toBe(2_000n);
  });
});

function decodeHeaders(headers: IHeaders | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined) {
      continue;
    }
    result[key] = Array.isArray(value) ? String(value[0]) : value.toString();
  }
  return result;
}
