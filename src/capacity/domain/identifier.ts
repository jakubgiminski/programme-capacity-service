import { z } from 'zod';

export const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, {
  message: 'Must be 1-64 characters of [A-Za-z0-9._:-] starting with a letter or digit',
});
