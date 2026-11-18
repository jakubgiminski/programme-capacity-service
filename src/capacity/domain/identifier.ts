import { z } from 'zod';

export const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/, { message: 'Must be 1-64 characters of [A-Za-z0-9._:-]' });
