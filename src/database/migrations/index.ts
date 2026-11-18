import { type Migration } from 'kysely';
import * as capacitySchema from './0001-capacity-schema';

export const migrations: Record<string, Migration> = {
  '0001-capacity-schema': capacitySchema,
};
