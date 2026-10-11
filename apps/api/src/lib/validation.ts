import type { z } from 'zod';
import { HttpError } from './errors';

/**
 * Zod-validated route input helper: parse or throw a client-safe 400.
 * Issue messages describe the REQUEST shape only — safe to leak.
 */
export function parse<Schema extends z.ZodType>(schema: Schema, data: unknown): z.infer<Schema> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new HttpError(400, `invalid request: ${detail}`);
  }
  return result.data;
}
