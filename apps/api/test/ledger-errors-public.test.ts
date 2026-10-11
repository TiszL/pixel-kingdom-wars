import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { InsufficientFundsError, LedgerError } from '../src/ledger';
import { HttpError } from '../src/lib/errors';
import { connectTestDb, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp(TEST_CONFIG, conn.db);
  app.get('/__funds', async () => { throw new InsufficientFundsError('private-account', 12n, -900n); });
  app.get('/__ledger', async () => { throw new LedgerError('ledger.invalid', 'private-ledger-details'); });
  app.get('/__price', async () => { throw new HttpError(422, 'Not enough SHARDS.', 'INSUFFICIENT_SHARDS'); });
  await app.ready();
});
afterAll(async () => { await app?.close(); await conn.sql.end(); });

describe('public ledger rejection copy', () => {
  it('explains insufficient funds without exposing internal accounts or ledger arithmetic', async () => {
    const response = await app.inject('/__funds');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: {
      code: 'ledger.insufficient_funds',
      message: 'Not enough funds for this action. Refresh your balances and try again.',
    } });
    expect(response.body).not.toMatch(/private-account|900|balance 12|delta/);
  });
  it('preserves other ledger codes without treating internal exception text as player copy', async () => {
    const response = await app.inject('/__ledger');
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('ledger.invalid');
    expect(response.json().error.message).toBe('This transaction could not be completed. Please try again.');
    expect(response.body).not.toContain('private-ledger-details');
  });
  it('retains currency-specific action errors for clients that open the matching funds prompt', async () => {
    const response = await app.inject('/__price');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: { code: 'INSUFFICIENT_SHARDS', message: 'Not enough SHARDS.' } });
  });
});
