import { z } from 'zod';
import { HttpError } from '../lib/errors';

const Output = z.string().max(32).regex(/^[1-9][0-9]*$/);
export const GemsConversionExpectedSchema = z.object({
  rate: z.number().int().positive().refine(Number.isSafeInteger), output: Output,
}).strict();
export const GemsTaskExpectedSchema = z.object({ rate: z.null(), output: Output }).strict();
export type GemsConversionExpected = z.infer<typeof GemsConversionExpectedSchema>;
export type GemsTaskExpected = z.infer<typeof GemsTaskExpectedSchema>;
type Expected = GemsConversionExpected | GemsTaskExpected;

/** Called only by the winning new-post hook, inside the ledger savepoint. */
export function assertGemsTerms(expected: Expected | undefined, rate: number | null, output: string): undefined {
  if (expected && (expected.rate !== rate || expected.output !== output)) {
    throw new HttpError(409, 'Gems terms changed; review the current terms before submitting', 'GEMS_TERMS_CHANGED');
  }
}

/** Consent is original command identity. Never attach new consent to an old key. */
export function assertSameGemsExpected(original: Expected | undefined, incoming: Expected | undefined): void {
  if ((original === undefined) !== (incoming === undefined)
    || original?.rate !== incoming?.rate || original?.output !== incoming?.output) {
    throw new HttpError(409, 'idempotency key was already used with different Gems terms', 'IDEMPOTENCY_BODY_MISMATCH');
  }
}
