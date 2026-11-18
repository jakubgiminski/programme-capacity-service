import { z } from 'zod';

const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .pipe(z.array(z.string().min(1)).min(1));

const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  KAFKA_ENABLED: booleanFlag.default(true),
  KAFKA_BROKERS: csv.default(['localhost:19092']),
  KAFKA_CLIENT_ID: z.string().min(1).default('programme-capacity-service'),
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
