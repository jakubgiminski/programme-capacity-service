import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { Kafka, logLevel, Partitioners } from 'kafkajs';
import { signDevToken } from './dev-token';
import { runScript } from './script-runner';

type Json = Record<string, unknown>;

interface Response {
  readonly status: number;
  readonly body: Json;
}

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const TOPIC = process.env.KAFKA_TOPIC ?? 'treasury.program-capacity.v1';
const DLQ_TOPIC = process.env.KAFKA_DLQ_TOPIC ?? 'treasury.program-capacity.v1.dlq';
const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');

const programId = `PRG-SMOKE-${randomUUID().slice(0, 8).toUpperCase()}`;
const kafka = new Kafka({ clientId: 'smoke-test', brokers: BROKERS, logLevel: logLevel.WARN });
const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
let token = '';

function check(condition: boolean, message: string, actual?: unknown): void {
  if (!condition) {
    throw new Error(`${message}${actual === undefined ? '' : `; got ${JSON.stringify(actual)}`}`);
  }
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  check(
    isDeepStrictEqual(actual, expected),
    `${label}: expected ${JSON.stringify(expected)}`,
    actual,
  );
}

function amount(value: string, currency = 'USD') {
  return { amount: value, currency };
}

async function call(method: 'GET' | 'POST', path: string, body?: Json): Promise<Response> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

function programPath(suffix: string): string {
  return `/v1/programs/${programId}/${suffix}`;
}

async function capacity(): Promise<Response> {
  return call('GET', programPath('capacity'));
}

async function eventually(label: string, done: (response: Response) => boolean): Promise<Json> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await capacity();
    if (done(response)) {
      return response.body;
    }
    check(Date.now() < deadline, `Timed out waiting for ${label}`, response.body);
    await sleep(250);
  }
}

function treasury(body: Json): Json {
  return body.treasury as Json;
}

function envelope(revision: number, type: string): Json {
  return {
    messageId: `${programId}-r${revision}`,
    programId,
    revision,
    type,
    occurredAt: new Date().toISOString(),
  };
}

async function publish(message: Json): Promise<void> {
  await producer.send({
    topic: TOPIC,
    acks: -1,
    messages: [{ key: programId, value: JSON.stringify(message) }],
  });
}

async function step(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  process.stdout.write(`ok - ${name}\n`);
}

async function deadLetterFor(messageId: string): Promise<string> {
  const consumer = kafka.consumer({ groupId: `smoke-dlq-${randomUUID()}` });
  const found: { reason: string | null } = { reason: null };
  await consumer.connect();
  try {
    await consumer.subscribe({ topic: DLQ_TOPIC, fromBeginning: true });
    await consumer.run({
      eachMessage: ({ message }) => {
        if (message.headers?.['x-message-id']?.toString() === messageId) {
          found.reason = message.headers['x-dlq-reason']?.toString() ?? '';
        }
        return Promise.resolve();
      },
    });
    const deadline = Date.now() + 30_000;
    while (found.reason === null) {
      check(Date.now() < deadline, `No dead letter for ${messageId}`);
      await sleep(250);
    }
    return found.reason;
  } finally {
    await consumer.disconnect();
  }
}

runScript(async () => {
  token = await signDevToken({
    scope: 'capacity:read capacity:write',
    subject: 'smoke-test',
    ttlSeconds: 600,
  });
  await producer.connect();
  try {
    await step('service is healthy', async () => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const health = await call('GET', '/health').catch(() => null);
        if (health?.status === 200) {
          expectEqual(
            health.body,
            { status: 'ok', checks: { database: 'up', kafka: 'up' } },
            'health',
          );
          return;
        }
        check(Date.now() < deadline, 'Timed out waiting for the service to become healthy', health);
        await sleep(1_000);
      }
    });

    await step('treasury creates the programme', async () => {
      await publish({ ...envelope(1, 'ProgramLimitSet'), currency: 'USD', limit: '1000000000' });
      const body = await eventually('programme creation', (response) => response.status === 200);
      expectEqual(body.limit, amount('1000000000'), 'limit');
      expectEqual(body.available, amount('1000000000'), 'available');
    });

    await step('reserves an EUR invoice at the locked rate, rounded up', async () => {
      const request = { invoiceId: 'INV-1', amount: amount('10000000', 'EUR') };
      const created = await call('POST', programPath('reservations'), request);
      const replay = await call('POST', programPath('reservations'), request);
      const conflict = await call('POST', programPath('reservations'), {
        ...request,
        amount: amount('10000001', 'EUR'),
      });
      expectEqual(created.status, 201, 'reserve status');
      expectEqual(created.body.booked, amount('10850000'), 'booked');
      expectEqual(replay, { status: 200, body: created.body }, 'idempotent replay');
      expectEqual(conflict.status, 409, 'conflict status');
      expectEqual(conflict.body.type, '/problems/invoice-conflict', 'conflict type');
    });

    await step('releases part of the invoice and replays the release', async () => {
      const request = { releaseId: 'REL-1', amount: amount('4000000', 'EUR') };
      const released = await call('POST', programPath('reservations/INV-1/releases'), request);
      const replay = await call('POST', programPath('reservations/INV-1/releases'), request);
      expectEqual(released.status, 201, 'release status');
      expectEqual(released.body.freed, amount('4340000'), 'freed');
      expectEqual((released.body.reservation as Json).status, 'PARTIALLY_RELEASED', 'status');
      expectEqual(
        (released.body.reservation as Json).outstanding,
        amount('6510000'),
        'outstanding',
      );
      expectEqual(replay, { status: 200, body: released.body }, 'release replay');
    });

    await step('refuses a reservation above the available capacity', async () => {
      const refused = await call('POST', programPath('reservations'), {
        invoiceId: 'INV-BIG',
        amount: amount('2000000000'),
      });
      expectEqual(refused.status, 409, 'status');
      expectEqual(refused.body.type, '/problems/insufficient-capacity', 'type');
    });

    await step('applies a snapshot with the fail-safe merge', async () => {
      await publish({
        ...envelope(2, 'ProgramSnapshot'),
        currency: 'USD',
        limit: '900000000',
        asOf: new Date().toISOString(),
        reservations: [
          {
            invoiceId: 'INV-1',
            invoiceAmount: '10000000',
            invoiceCurrency: 'EUR',
            outstandingInvoiceAmount: '6000000',
            bookedAmount: '5000000',
          },
          {
            invoiceId: 'TRE-1',
            invoiceAmount: '25000000',
            invoiceCurrency: 'USD',
            outstandingInvoiceAmount: '25000000',
            bookedAmount: '25000000',
          },
        ],
      });
      const body = await eventually(
        'the snapshot',
        (response) => treasury(response.body).revision === '2',
      );
      expectEqual(body.limit, amount('900000000'), 'limit');
      expectEqual(body.utilised, amount('31510000'), 'utilised');
      expectEqual(body.openDiscrepancies, 1, 'open discrepancies');
      const list = await call('GET', programPath('discrepancies'));
      const [discrepancy] = list.body.discrepancies as Json[];
      expectEqual(discrepancy?.invoiceId, 'INV-1', 'discrepancy invoice');
      expectEqual(discrepancy?.kind, 'TREASURY_AMOUNT_LOWER', 'discrepancy kind');
    });

    await step('keeps treasury-owned invoices out of the API', async () => {
      const refused = await call('POST', programPath('reservations'), {
        invoiceId: 'TRE-1',
        amount: amount('25000000'),
      });
      expectEqual(refused.status, 409, 'status');
    });

    await step('admits against a lower limit parked behind a gap', async () => {
      await publish({ ...envelope(4, 'ProgramLimitSet'), currency: 'USD', limit: '20000000' });
      const parked = await eventually(
        'the parked limit',
        (response) => treasury(response.body).parkedMessages === 1,
      );
      expectEqual(treasury(parked).pendingLimit, amount('20000000'), 'pending limit');
      expectEqual(parked.overUtilised, true, 'over-utilised');
      const refused = await call('POST', programPath('reservations'), {
        invoiceId: 'INV-2',
        amount: amount('1'),
      });
      expectEqual(refused.status, 409, 'admission during the gap');
      await publish({ ...envelope(3, 'ProgramLimitSet'), currency: 'USD', limit: '800000000' });
      const closed = await eventually(
        'the gap to close',
        (response) => treasury(response.body).revision === '4',
      );
      expectEqual(closed.limit, amount('20000000'), 'limit after the gap');
      expectEqual(treasury(closed).parkedMessages, 0, 'parked messages');
    });

    await step('dead-letters a repayment for an unknown invoice', async () => {
      await publish({ ...envelope(5, 'InvoiceRepaid'), invoiceId: 'UNKNOWN', releaseId: 'R-1' });
      await eventually('the rejection', (response) => treasury(response.body).revision === '5');
      const reason = await deadLetterFor(`${programId}-r5`);
      check(reason.includes('reservation-not-found'), 'Unexpected dead-letter reason', reason);
    });

    await step('releases the remainder of the invoice', async () => {
      const released = await call('POST', programPath('reservations/INV-1/releases'), {
        releaseId: 'REL-2',
      });
      expectEqual(released.status, 201, 'status');
      expectEqual((released.body.reservation as Json).status, 'RELEASED', 'reservation status');
      const body = await capacity();
      expectEqual(body.body.utilised, amount('25000000'), 'utilised');
    });

    process.stdout.write(`Smoke test passed for ${programId}\n`);
  } finally {
    await producer.disconnect();
  }
});
