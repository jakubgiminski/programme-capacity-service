import { type MigrationResultSet, Migrator } from 'kysely';
import { type Db } from './database';
import { migrations } from './migrations';

export async function migrateToLatest(db: Db): Promise<MigrationResultSet> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });
  const result = await migrator.migrateToLatest();
  if (result.error !== undefined) {
    throw result.error instanceof Error ? result.error : new Error('Database migration failed');
  }
  return result;
}
