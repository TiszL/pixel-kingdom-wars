/** Oversized base58 text must be refused before allocating decoder state. */
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { qualifyDeedMiningRosterDay, type DeedMiningRosterSource } from '../src/mining/deedRosterQualification';

const constructed = vi.hoisted(() => vi.fn());
vi.mock('@solana/web3.js', async importOriginal => {
 const actual = await importOriginal<typeof import('@solana/web3.js')>();
 return { ...actual, PublicKey: new Proxy(actual.PublicKey, {
  construct(target, args, newTarget) {
   constructed(args[0]);
   return Reflect.construct(target, args, newTarget);
  },
 }) };
});

describe('deed roster public-key input bounds', () => {
 it('never constructs a PublicKey for an oversized valid-base58 wallet', async () => {
  constructed.mockClear();
  await expect(qualifyDeedMiningRosterDay({} as Db, {} as DeedMiningRosterSource, {
   wallet: '1'.repeat(100_000), day: '2035-01-02', policyVersion: 1,
  })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(constructed).not.toHaveBeenCalled();
 });
 it('retains actual constructor validation for an ordinary canonical wallet', async () => {
  constructed.mockClear(); const wallet = '1'.repeat(32);
  await expect(qualifyDeedMiningRosterDay({} as Db, { collection: 'bad' } as DeedMiningRosterSource, {
   wallet, day: '2035-01-02', policyVersion: 1,
  })).rejects.toMatchObject({ code: 'SOURCE_CONFIGURATION_INVALID' });
  expect(constructed.mock.calls).toEqual([[wallet]]);
 });
});
