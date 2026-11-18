import { Logger } from '@nestjs/common';
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import { Pool, TypeOverrides } from 'pg';
import { type Database } from './database.types';

export type Db = Kysely<Database>;
export type DbTransaction = Transaction<Database>;

export const DATABASE = Symbol('DATABASE');

const INT8_OID = 20;

function typeOverrides(): TypeOverrides {
  const overrides = new TypeOverrides();
  overrides.setTypeParser(INT8_OID, 'text', (value) => BigInt(value));
  return overrides;
}

export interface DatabaseOptions {
  connectionString: string;
  maxConnections: number;
  applicationName?: string;
}

export function createDatabase(options: DatabaseOptions): Db {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections,
    application_name: options.applicationName ?? 'programme-capacity-service',
    types: typeOverrides(),
  });
  const logger = new Logger('Database');
  pool.on('error', (error) => {
    logger.warn({ err: error }, 'Idle database connection failed and was discarded');
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
