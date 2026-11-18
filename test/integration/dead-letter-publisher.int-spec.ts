import { type Kafka, type ProducerRecord } from 'kafkajs';
import { TreasuryRepository } from '../../src/capacity/infrastructure/treasury.repository';
import { loadConfig } from '../../src/config/config';
import { DeadLetterPublisher } from '../../src/treasury/dead-letter-publisher';
import { eventually } from '../support/eventually';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

describe('DeadLetterPublisher (Postgres)', () => {
  let database: TestDatabase;
  const sent: ProducerRecord[] = [];
  let failing = new Set<string>();

  const producer = {
    connect: jest.fn(() => Promise.resolve()),
    disconnect: jest.fn(() => Promise.resolve()),
    send: jest.fn((record: ProducerRecord) => {
      const offset = String(record.messages[0]?.headers?.['x-original-offset']);
      if (failing.has(offset)) {
        return Promise.reject(new Error(`broker refused ${offset}`));
      }
      sent.push(record);
      return Promise.resolve([]);
    }),
  };
  const kafka = { producer: () => producer } as unknown as Kafka;
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused@localhost/unused',
    JWT_ISSUER: 'issuer',
    JWT_AUDIENCE: 'audience',
    JWT_PUBLIC_KEY: 'unused',
  });

  async function record(offset: string, payload: Buffer | null): Promise<void> {
    await new TreasuryRepository().addDeadLetter(database.db, {
      messageId: null,
      programId: null,
      revision: null,
      reason: 'Message value is not valid JSON',
      key: Buffer.from('PRG-1'),
      payload,
      source: { topic: 'treasury', partition: 0, offset },
    });
  }

  function rows() {
    return database.db
      .selectFrom('treasury_dead_letters')
      .select(['source_offset', 'attempts', 'last_error', 'published_at'])
      .orderBy('source_offset')
      .execute();
  }

  beforeEach(async () => {
    database = await createTestDatabase(5);
    sent.length = 0;
    failing = new Set();
  });

  afterEach(async () => {
    await database.destroy();
  });

  it('publishes every row with its original bytes and headers', async () => {
    await record('1', Buffer.from('{not json'));
    await record('2', null);
    const publisher = new DeadLetterPublisher(config, kafka, database.db, new TreasuryRepository());

    publisher.notify();
    await eventually(rows, (current) => current.every((row) => row.published_at !== null));
    await publisher.onApplicationShutdown();

    expect(sent.map((item) => item.messages[0]?.value)).toEqual([Buffer.from('{not json'), null]);
    expect(sent[0]).toMatchObject({
      topic: config.KAFKA_DLQ_TOPIC,
      acks: -1,
      messages: [
        {
          key: Buffer.from('PRG-1'),
          headers: {
            'x-dlq-reason': 'Message value is not valid JSON',
            'x-original-topic': 'treasury',
            'x-original-partition': '0',
            'x-original-offset': '1',
          },
        },
      ],
    });
  });

  it('records failed attempts without blocking the other rows and retries them later', async () => {
    await record('1', Buffer.from('a'));
    await record('2', Buffer.from('b'));
    failing = new Set(['1']);
    const publisher = new DeadLetterPublisher(config, kafka, database.db, new TreasuryRepository());

    publisher.notify();
    await eventually(rows, (current) => current[1]?.published_at !== null);
    const afterFailure = await rows();
    failing = new Set();
    publisher.notify();
    await eventually(rows, (current) => current[0]?.published_at !== null);
    await publisher.onApplicationShutdown();

    expect(afterFailure[0]).toMatchObject({
      attempts: 1,
      last_error: 'broker refused 1',
      published_at: null,
    });
    expect(await rows()).toEqual([
      expect.objectContaining({ source_offset: '1', attempts: 1, last_error: null }),
      expect.objectContaining({ source_offset: '2', attempts: 0, last_error: null }),
    ]);
  });
});
