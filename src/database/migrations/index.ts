import { type Migration } from 'kysely';
import * as capacitySchema from './0001-capacity-schema';
import * as treasuryIngestion from './0002-treasury-ingestion';

export const migrations: Record<string, Migration> = {
  '0001-capacity-schema': capacitySchema,
  '0002-treasury-ingestion': treasuryIngestion,
};
