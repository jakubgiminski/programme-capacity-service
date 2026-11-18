import { Kafka, logLevel, Partitioners } from 'kafkajs';
import { runScript } from './script-runner';

type Message = Record<string, unknown>;

const OCCURRED_AT = '2026-11-18T09:00:00Z';

function envelope(programId: string, revision: number, type: string): Message {
  return {
    messageId: `${programId}-r${revision}-${type}`,
    programId,
    revision,
    type,
    occurredAt: OCCURRED_AT,
  };
}

const scenarios: Record<string, Message[]> = {
  lifecycle: [
    { ...envelope('PRG-TRE-001', 1, 'ProgramLimitSet'), currency: 'USD', limit: '500000000' },
    {
      ...envelope('PRG-TRE-001', 2, 'ProgramSnapshot'),
      currency: 'USD',
      limit: '500000000',
      asOf: OCCURRED_AT,
      reservations: [
        {
          invoiceId: 'TRE-1',
          invoiceAmount: '2000000',
          invoiceCurrency: 'EUR',
          outstandingInvoiceAmount: '2000000',
          bookedAmount: '2170000',
        },
        {
          invoiceId: 'TRE-2',
          invoiceAmount: '5000000',
          invoiceCurrency: 'USD',
          outstandingInvoiceAmount: '5000000',
          bookedAmount: '5000000',
        },
      ],
    },
    {
      ...envelope('PRG-TRE-001', 4, 'ProgramLimitSet'),
      currency: 'USD',
      limit: '600000000',
    },
    {
      ...envelope('PRG-TRE-001', 3, 'InvoiceRepaid'),
      invoiceId: 'TRE-2',
      releaseId: 'TRE-2-repayment-1',
      amount: { amount: '1000000', currency: 'USD' },
    },
    {
      ...envelope('PRG-TRE-001', 3, 'InvoiceRepaid'),
      invoiceId: 'TRE-2',
      releaseId: 'TRE-2-repayment-1',
      amount: { amount: '1000000', currency: 'USD' },
    },
    { ...envelope('PRG-TRE-001', 5, 'InvoiceRepaid'), invoiceId: 'UNKNOWN', releaseId: 'R-1' },
  ],
  'snapshot-usd': [
    {
      ...envelope('PRG-USD-001', 1, 'ProgramSnapshot'),
      currency: 'USD',
      limit: '900000000',
      asOf: OCCURRED_AT,
      reservations: [
        {
          invoiceId: 'INV-1001',
          invoiceAmount: '10000000',
          invoiceCurrency: 'EUR',
          outstandingInvoiceAmount: '6000000',
          bookedAmount: '5000000',
        },
        {
          invoiceId: 'TRE-9001',
          invoiceAmount: '25000000',
          invoiceCurrency: 'USD',
          outstandingInvoiceAmount: '25000000',
          bookedAmount: '25000000',
        },
      ],
    },
  ],
};

runScript(async () => {
  const name = process.argv[2] ?? 'lifecycle';
  const messages = scenarios[name];
  if (messages === undefined) {
    throw new Error(`Unknown scenario "${name}"; use one of: ${Object.keys(scenarios).join(', ')}`);
  }
  const kafka = new Kafka({
    clientId: 'sample-producer',
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(','),
    logLevel: logLevel.WARN,
  });
  const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
  const topic = process.env.KAFKA_TOPIC ?? 'treasury.program-capacity.v1';
  await producer.connect();
  try {
    for (const message of messages) {
      await producer.send({
        topic,
        acks: -1,
        messages: [{ key: String(message.programId), value: JSON.stringify(message) }],
      });
      process.stdout.write(
        `sent ${String(message.type)} r${String(message.revision)} for ${String(message.programId)}\n`,
      );
    }
  } finally {
    await producer.disconnect();
  }
});
