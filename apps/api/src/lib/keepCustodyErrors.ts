import { HttpError } from './errors';

/** Only these exact database refusals are safe to expose across query wrappers. */
export function custodyRefusal(error: unknown): HttpError | undefined {
  const seen = new Set<object>();
  let current = error;
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === 'P0001') {
      if (candidate.message === 'KEEP_CUSTODY_FROZEN') {
        return new HttpError(423,
          'Custodial KEEP is retired. Refresh your balances and use Gems.',
          'KEEP_CUSTODY_FROZEN');
      }
      if (candidate.message === 'KEEP_CUSTODY_CLOSING') {
        return new HttpError(423,
          'Custodial KEEP deposits are closing. Refresh before trying again.',
          'KEEP_CUSTODY_CLOSING');
      }
    }
    current = candidate.cause;
  }
  return undefined;
}
