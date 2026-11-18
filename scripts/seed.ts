import { createDatabase } from '../src/database/database';
import { requireEnv, runScript } from './script-runner';

const PROGRAMMES = [
  { id: 'PRG-USD-001', currency: 'USD', limitMinor: 1_000_000_000n },
  { id: 'PRG-EUR-001', currency: 'EUR', limitMinor: 500_000_000n },
  { id: 'PRG-JPY-001', currency: 'JPY', limitMinor: 1_000_000_000n },
];

runScript(async () => {
  const db = createDatabase({ connectionString: requireEnv('DATABASE_URL'), maxConnections: 1 });
  try {
    for (const programme of PROGRAMMES) {
      const created = await db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto('programs')
          .values({
            id: programme.id,
            currency: programme.currency,
            limit_minor: programme.limitMinor,
          })
          .onConflict((conflict) => conflict.column('id').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (inserted === undefined) {
          return false;
        }
        await trx
          .insertInto('ledger_entries')
          .values({
            type: 'LIMIT_SET',
            program_id: programme.id,
            reservation_id: null,
            delta_minor: programme.limitMinor,
            utilised_after_minor: 0n,
            limit_after_minor: programme.limitMinor,
            actor: 'seed',
            correlation_id: null,
            source_message_id: null,
            reason: 'PROGRAM_CREATED',
          })
          .execute();
        return true;
      });
      process.stdout.write(`${created ? 'seeded' : 'exists'}: ${programme.id}\n`);
    }
  } finally {
    await db.destroy();
  }
});
