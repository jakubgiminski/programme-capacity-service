import { createDatabase } from '../src/database/database';
import { migrateToLatest } from '../src/database/migrator';
import { requireEnv, runScript } from './script-runner';

runScript(async () => {
  const db = createDatabase({ connectionString: requireEnv('DATABASE_URL'), maxConnections: 1 });
  try {
    const result = await migrateToLatest(db);
    for (const migration of result.results ?? []) {
      process.stdout.write(`${migration.status}: ${migration.migrationName}\n`);
    }
  } finally {
    await db.destroy();
  }
});
