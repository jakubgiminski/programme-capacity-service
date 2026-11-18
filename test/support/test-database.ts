import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createDatabase, type Db } from '../../src/database/database';

export const TEMPLATE_DATABASE = 'capacity_template';

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  readonly db: Db;
  destroy(): Promise<void>;
}

function adminUrl(): string {
  const url = process.env.TEST_POSTGRES_ADMIN_URL;
  if (url === undefined) {
    throw new Error('TEST_POSTGRES_ADMIN_URL is not set; run integration tests through Jest');
  }
  return url;
}

export async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(maxConnections = 30): Promise<TestDatabase> {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await withAdminClient((client) =>
    client.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE}"`),
  );
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const db = createDatabase({ connectionString: url.toString(), maxConnections });
  return {
    name,
    url: url.toString(),
    db,
    destroy: () => db.destroy(),
  };
}
