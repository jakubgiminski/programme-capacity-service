import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabase } from '../../src/database/database';
import { migrateToLatest } from '../../src/database/migrator';
import { TEMPLATE_DATABASE } from './test-database';

declare global {
  var postgresContainer: StartedPostgreSqlContainer | undefined;
}

export default async function globalSetup(): Promise<void> {
  const container = await new PostgreSqlContainer('postgres:16.16-alpine')
    .withDatabase(TEMPLATE_DATABASE)
    .withUsername('test')
    .withPassword('test')
    .withCommand(['postgres', '-c', 'max_connections=500', '-c', 'fsync=off'])
    .start();
  const db = createDatabase({ connectionString: container.getConnectionUri(), maxConnections: 1 });
  try {
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
  const adminUrl = new URL(container.getConnectionUri());
  adminUrl.pathname = '/postgres';
  process.env.TEST_POSTGRES_ADMIN_URL = adminUrl.toString();
  globalThis.postgresContainer = container;
}
