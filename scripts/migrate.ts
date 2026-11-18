import { loadConfig } from '../src/config/config';
import { createDatabase } from '../src/database/database';
import { migrateToLatest } from '../src/database/migrator';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = createDatabase({ connectionString: config.DATABASE_URL, maxConnections: 1 });
  try {
    const result = await migrateToLatest(db);
    for (const migration of result.results ?? []) {
      process.stdout.write(`${migration.status}: ${migration.migrationName}\n`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
