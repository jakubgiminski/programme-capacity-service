import { z } from 'zod';

const brokerSchema = z
  .string()
  .regex(/^[A-Za-z0-9.-]+:[0-9]{1,5}$/, { message: 'Broker must be host:port' })
  .refine((broker) => {
    const port = Number(broker.slice(broker.lastIndexOf(':') + 1));
    return port >= 1 && port <= 65535;
  }, 'Broker port must be between 1 and 65535');

const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .pipe(z.array(brokerSchema).min(1));

const databaseUrlSchema = z
  .url({ protocol: /^postgres(ql)?$/ })
  .refine((value) => new URL(value).hostname.length > 0, 'DATABASE_URL must include a host');

const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: databaseUrlSchema,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  KAFKA_ENABLED: booleanFlag.default(true),
  KAFKA_BROKERS: csv.default(['localhost:19092']),
  KAFKA_SSL: booleanFlag.default(false),
  KAFKA_SASL_MECHANISM: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).optional(),
  KAFKA_SASL_USERNAME: z.string().min(1).optional(),
  KAFKA_SASL_PASSWORD: z.string().min(1).optional(),
  KAFKA_CREATE_TOPICS: booleanFlag.default(true),
  KAFKA_CLIENT_ID: z.string().min(1).default('programme-capacity-service'),
  KAFKA_GROUP_ID: z.string().min(1).default('programme-capacity-service'),
  KAFKA_TOPIC: z.string().min(1).default('treasury.program-capacity.v1'),
  KAFKA_DLQ_TOPIC: z.string().min(1).default('treasury.program-capacity.v1.dlq'),
  KAFKA_TOPIC_PARTITIONS: z.coerce.number().int().min(1).max(64).default(3),
  KAFKA_PARTITIONS_CONSUMED_CONCURRENTLY: z.coerce.number().int().min(1).max(64).default(3),
  KAFKA_RETRY_MAX_BACKOFF_MS: z.coerce.number().int().min(10).max(300_000).default(30_000),
  FX_RATES_FILE: z.string().min(1).default('config/fx-rates.json'),
  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1).optional(),
  JWT_PUBLIC_KEY_FILE: z.string().min(1).optional(),
  JWT_JWKS_URL: z.url({ protocol: /^https?$/ }).optional(),
});

const configSchema = baseSchema.superRefine((config, context) => {
  const keySources = [config.JWT_PUBLIC_KEY, config.JWT_PUBLIC_KEY_FILE, config.JWT_JWKS_URL];
  if (
    config.NODE_ENV === 'production' &&
    config.JWT_JWKS_URL !== undefined &&
    !config.JWT_JWKS_URL.startsWith('https://')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['JWT_JWKS_URL'],
      message: 'JWT_JWKS_URL must use https in production',
    });
  }
  const saslSettings = [
    config.KAFKA_SASL_MECHANISM,
    config.KAFKA_SASL_USERNAME,
    config.KAFKA_SASL_PASSWORD,
  ];
  if (new Set(saslSettings.map((setting) => setting === undefined)).size > 1) {
    context.addIssue({
      code: 'custom',
      path: ['KAFKA_SASL_MECHANISM'],
      message: 'Set KAFKA_SASL_MECHANISM, KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD together',
    });
  }
  if (config.KAFKA_TOPIC === config.KAFKA_DLQ_TOPIC) {
    context.addIssue({
      code: 'custom',
      path: ['KAFKA_DLQ_TOPIC'],
      message: 'KAFKA_DLQ_TOPIC must differ from KAFKA_TOPIC',
    });
  }
  if (keySources.filter((source) => source !== undefined).length !== 1) {
    context.addIssue({
      code: 'custom',
      path: ['JWT_PUBLIC_KEY'],
      message: 'Set exactly one of JWT_PUBLIC_KEY, JWT_PUBLIC_KEY_FILE or JWT_JWKS_URL',
    });
  }
});

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigValidationError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const result = configSchema.safeParse(env);
  if (result.success) {
    return result.data;
  }
  throw new ConfigValidationError(
    result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  );
}
