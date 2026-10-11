import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { KeepMarketController, type KeepMarketPorts } from './controller';
import { KeepMarketJournalStore, marketKey } from './journal';
import { KeepMarketJournalStore as BaseJournal } from './journal.base.test-support';
import { keepMarketFixture } from './fixtures.testHelpers';
import { prepareKeepEquipmentSigning, signKeepEquipment } from './signing';
const stores: Array<{ close(): Promise<void> }> = [];
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); vi.unstubAllGlobals(); });
function fixture() {
  const f = keepMarketFixture(), factory = new IDBFactory();
  const identity = { origin: 'http://localhost', api: 'http://localhost/api', cluster: 'devnet' as const, wallet: f.value.fill.buyerWallet };
  const store = new KeepMarketJournalStore(identity, factory); stores.push(store);
  const command = { kind: 'fill' as const, key: f.value.fill.id, request: { idempotencyKey: f.value.fill.id, listingId: f.value.fill.listingId, buyerBaseId: f.value.fill.buyerBaseId, quantity: f.value.fill.quantity } };
  return { ...f, factory, identity, store, command, key: marketKey(command) };
}
const refusal = () => new ApiError(409, 'A deed is required', 'KEEP_EQUIPMENT_MARKET_DEED_REQUIRED');
function controller(f: ReturnType<typeof fixture>, error: Error, key: () => string = () => crypto.randomUUID()) {
  const request = vi.fn<KeepMarketPorts['request']>().mockRejectedValue(error);
  const ports: KeepMarketPorts = { capture: () => () => undefined, key, lock: async (_key, run) => run(), request,
    review: async () => { throw Error('unexpected wallet review'); }, sign: async () => { throw Error('unexpected signing'); } };
  return { controller: new KeepMarketController(f.store, ports), request };
}
it('33 refused creates cannot fill recovery storage because no server row was admitted', async () => {
  const f = fixture(), h = controller(f, refusal());
  for (let n = 0; n < 33; n++) {
    await expect(h.controller.begin('fill', f.command.request)).rejects.toThrow('A deed is required');
    expect((await f.store.read()).pending).toHaveLength(0);
  }
  expect(h.request).toHaveBeenCalledTimes(33); expect(h.controller.getSnapshot().selected).toBeNull();
  expect(h.controller.getSnapshot().error).toBe('A deed is required');
});
it('a current DEED_OWNERSHIP_CHANGED create refusal is removed without adding a global-handler retry', async () => {
  const f = fixture(), h = controller(f, new ApiError(409, 'changed', 'DEED_OWNERSHIP_CHANGED'));
  await expect(h.controller.begin('fill', f.command.request)).rejects.toThrow('changed');
  expect((await f.store.read()).pending).toHaveLength(0); expect(h.request).toHaveBeenCalledOnce();
});
it.each([Error('timeout'), new ApiError(503, 'disabled', 'PHASE_E_DISABLED'), new ApiError(500, 'outage'), new ApiError(409, 'unrelated', 'OTHER'), new ApiError(503, 'deed unavailable', 'KEEP_EQUIPMENT_MARKET_DEED_REQUIRED')])('uncertain failure preserves its exact saved request because the server may have accepted it (%s)', async error => {
  const f = fixture(), h = controller(f, error);
  await expect(h.controller.begin('fill', f.command.request)).rejects.toThrow();
  expect((await f.store.read()).pending).toHaveLength(1); expect(h.request).toHaveBeenCalledOnce();
});
it('fixed storage remains readable by the byte-identical base parser after a refusal', async () => {
  const f = fixture(); await f.store.begin(f.command);
  expect(await f.store.refuseCreate(f.key, refusal())).toBe(true);
  const survivor = { ...f.command, key: crypto.randomUUID(), request: { ...f.command.request, idempotencyKey: crypto.randomUUID() } }; survivor.request.idempotencyKey = survivor.key;
  await f.store.begin(survivor);
  const base = new BaseJournal(f.identity, f.factory); stores.push(base);
  const current = await f.store.read(), rollback = await base.read(); expect(rollback).toEqual(current);
  expect(Object.keys(rollback.pending[0]!).sort()).toEqual(['actions', 'command', 'observedComplete', 'original', 'signingStarted', 'wire']);
  expect(rollback.archive).toHaveLength(0);
});
it('an original, signing marker, or real signed wire can never be removed by a refusal', async () => {
  const f = fixture(); await f.store.begin(f.command); await f.store.retain(f.key, f.value);
  expect(await f.store.refuseCreate(f.key, refusal())).toBe(false);
  await f.store.startSigning(f.key); expect(await f.store.refuseCreate(f.key, refusal())).toBe(false);
  const prepared = await prepareKeepEquipmentSigning(f.value, f.trust, f.identity.wallet), wire = await signKeepEquipment(prepared, f.signer);
  await f.store.retainSigned(f.key, wire); expect(await f.store.refuseCreate(f.key, refusal())).toBe(false);
  expect((await f.store.read()).pending[0]!.wire).toEqual(wire);
});
it('a refused key cannot be recycled with different intent within this session or after remount', async () => {
  const f = fixture(); await f.store.begin(f.command); await f.store.refuseCreate(f.key, refusal());
  const changed = { ...f.command, request: { ...f.command.request, quantity: '2' } };
  await expect(f.store.begin(changed)).rejects.toThrow();
  const reopened = new KeepMarketJournalStore(f.identity, f.factory); stores.push(reopened);
  await expect(reopened.begin(changed)).rejects.toThrow();
});
it('a recovery read refusal never discards a saved create because only the create response proves non-admission', async () => {
  const f = fixture(); await f.store.begin(f.command);
  const h = controller(f, refusal()); h.controller.select(f.key);
  await expect(h.controller.recover()).rejects.toThrow(); expect((await f.store.read()).pending).toHaveLength(1);
});
it('an original retained before a contradictory refusal survives and remains recoverable', async () => {
  const f = fixture(); const h = controller(f, refusal(), () => f.command.key);
  h.request.mockImplementation(async (_request, _guard, retain) => { await retain(f.value); throw refusal(); });
  await expect(h.controller.begin('fill', f.command.request)).rejects.toThrow();
  expect((await f.store.read()).pending[0]!.original).toEqual(f.value);
});
