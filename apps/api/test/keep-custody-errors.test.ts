/** Custody fences must reach installed clients as typed refusals, without
 * exposing SQL details or mistaking an unrelated database error for a freeze. */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { custodyRefusal } from '../src/lib/keepCustodyErrors';
import { connectTestDb, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
let app: FastifyInstance;
let failure: unknown;
beforeAll(async () => {
  app = await buildApp(TEST_CONFIG, conn.db);
  app.get('/fixture-custody-error', async () => { throw failure; });
  await app.ready();
});
afterAll(async () => { await app?.close(); await conn.sql.end(); });

describe('custody database error boundary', () => {
  it.each(['KEEP_CUSTODY_FROZEN', 'KEEP_CUSTODY_CLOSING'] as const)(
    'returns typed 423 for direct and query-wrapped %s without SQL details', async code => {
      const databaseError = Object.assign(new Error(code), {
        code: 'P0001', detail: 'private fixture SQL detail', query: 'private fixture query',
      });
      for (const error of [databaseError, new Error('query wrapper', { cause: databaseError })]) {
        failure = error;
        const response = await app.inject({ method: 'GET', url: '/fixture-custody-error' });
        expect(response.statusCode).toBe(423);
        expect(response.json()).toEqual({ error: {
          code, message: code === 'KEEP_CUSTODY_FROZEN'
            ? 'Custodial KEEP is retired. Refresh your balances and use Gems.'
            : 'Custodial KEEP deposits are closing. Refresh before trying again.',
        } });
        expect(response.body).not.toMatch(/private fixture|query wrapper/);
      }
    },
  );

  it.each([
    { code: '23505', message: 'KEEP_CUSTODY_FROZEN' },
    { code: 'P0001', message: 'KEEP_CUSTODY_FROZEN: unexpected detail' },
    { code: 'P0001', message: 'UNRELATED_CONSTRAINT' },
    { message: 'KEEP_CUSTODY_FROZEN' },
  ])('does not convert unrelated errors into definitive custody refusals (%j)', error => {
    expect(custodyRefusal(error)).toBeUndefined();
  });

  it('terminates safely on a circular wrapper', () => {
    const error: { cause?: unknown } = {}; error.cause = error;
    expect(custodyRefusal(error)).toBeUndefined();
  });
});
