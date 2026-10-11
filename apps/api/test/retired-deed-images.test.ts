import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as deedMetadata from '../src/game/deedMetadata';
import { canPublishWalletDeedAlias } from '../src/game/fantasyPublishing';
import { eq } from 'drizzle-orm';
import { sweepDeedMetadata } from '../src/game/deedR2';
import { sweepDeedChain } from '../src/game/deedChainSync';
import { buildApp } from '../src/app';
import { baseAbandons, bases, fantasyRetirementExclusions, ledgerTransactions, players } from '../src/db/schema';
import { retiredDeedImageForAsset, retiredDeedImageForWallet } from '../src/game/retiredDeedImages';
import { randomWallet, TEST_CONFIG } from './helpers';
import { isolatedFantasyTestDb } from './fantasy-test-db';

const conn = isolatedFantasyTestDb(); const db = conn.db;
const source = fileURLToPath(new URL('../../../art/retired-deed-images-v1/', import.meta.url));
let root: string; let folder: string; let app: Awaited<ReturnType<typeof buildApp>>;
let manifest: { entries: Array<{ mintId: string; walletAlias: string; asset: { file: string; sha256: string }; wallet: { file: string; sha256: string } }> };
beforeAll(async () => {
  await conn.prepare();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'retired-images-'));
  folder = path.join(root, 'apps/web/public/atlas/retired-deeds');
  await fs.mkdir(path.dirname(folder), { recursive: true }); await fs.cp(source, folder, { recursive: true });
  manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
  vi.stubEnv('REPO_ROOT', root); vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('FANTASY_WORLD_ENABLED', 'false');
  for (const entry of manifest.entries) {
    const retiredAt = new Date(); const baseId = randomUUID();
    await db.insert(players).values({ wallet: entry.walletAlias, deedAssetId: entry.mintId });
    await db.insert(bases).values({ id: baseId, ownerWallet: entry.walletAlias, deedAssetId: entry.mintId,
      landPaidAt: retiredAt, status: 'inactive', createdAt: new Date(retiredAt.getTime() - 1_000) });
    const [receipt] = await db.insert(ledgerTransactions).values({ type: 'retire.scripted-deed',
      idempotencyKey: `retired-images:${randomUUID()}`, metadata: { wallet: entry.walletAlias }, createdAt: retiredAt }).returning();
    const [abandon] = await db.insert(baseAbandons).values({ playerWallet: entry.walletAlias,
      priorKeepLevel: 1, priorExpansions: 0, buildingsDeleted: 0, obstaclesTombstoned: 0, jobsDeleted: 0, createdAt: retiredAt }).returning();
    expect(receipt?.id).toBeDefined(); expect(abandon?.id).toBeDefined();
  }
  app = await buildApp(TEST_CONFIG, db);
});
afterAll(async () => { await app?.close(); await conn.dispose(); vi.unstubAllEnvs(); if (root) await fs.rm(root, { recursive: true, force: true }); });

describe('retired public deed image preservation', () => {
  it('serves all eleven asset images and wallet aliases unchanged before the exclusion import', async () => {
    expect(await db.select().from(fantasyRetirementExclusions)).toHaveLength(0);
    expect(manifest.entries).toHaveLength(11);
    for (const entry of manifest.entries) for (const kind of ['asset', 'wallet'] as const) {
      const original = await fs.readFile(path.join(source, entry[kind].file));
      const response = await app.inject({ url: kind === 'asset' ? `/deed/asset/${entry.mintId}.png` : `/deed/${entry.walletAlias}.png` });
      expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toBe('image/png');
      expect(response.rawPayload.equals(original)).toBe(true);
      expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(entry[kind].sha256);
    }
  });
  it('never grants archive status to unknown identities without positive archive or DB evidence', async () => {
    expect(await retiredDeedImageForAsset(db, randomWallet())).toBeNull();
    expect(await retiredDeedImageForWallet(db, randomWallet())).toBeNull();
  });
  it('fails closed on corrupted captured bytes instead of silently repainting the retired deed', async () => {
    const entry = manifest.entries[0]!; const filename = path.join(folder, entry.asset.file);
    const original = await fs.readFile(filename);
    try {
      await fs.writeFile(filename, 'damaged');
      await expect(retiredDeedImageForAsset(db, entry.mintId)).rejects.toThrow('differ');
      expect((await app.inject({ url: `/deed/asset/${entry.mintId}.png` })).statusCode).toBe(500);
    } finally { await fs.writeFile(filename, original); }
  });
  it('excludes every audited mint from both publishing sweeps before import, on stable and wallet paths', async () => {
    expect(await db.select().from(fantasyRetirementExclusions)).toHaveLength(0);
    const wallet = randomWallet(); const mint = randomWallet(); const baseId = randomUUID();
    await db.insert(players).values({ wallet, deedAssetId: mint, entryPaidAt: new Date() });
    await db.insert(bases).values({ id: baseId, ownerWallet: wallet, deedAssetId: mint, landPaidAt: new Date(), status: 'inactive' });
    try {
      for (const stable of ['true', 'false']) {
        vi.stubEnv('MULTI_BASE_ENABLED', stable);
        const visited: string[] = []; const writes: string[] = [];
        await sweepDeedMetadata(db, async key => { writes.push(key); }, new Map(), {
          onVisit: asset => visited.push(asset), limit: 100, renderAvailable: false,
        });
        expect(visited).toEqual([mint]);
        expect(writes.length).toBeGreaterThan(0);
        for (const entry of manifest.entries) expect(writes.some(key => key.includes(entry.mintId) || key.includes(entry.walletAlias))).toBe(false);
        const queried: string[] = []; const sent: string[] = [];
        await sweepDeedChain(db, { publicBaseUrl: 'https://example.invalid' }, async updates => {
          sent.push(...updates.map(update => update.asset));
          return { updated: updates.length, txs: 0, alreadyCurrent: 0, missing: [] };
        }, { limit: 100, published: asset => { queried.push(asset); return '{}'; } });
        expect(queried).toEqual([mint]); expect(sent).toEqual([mint]);
      }
    } finally { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); }
  });

  it('publishes a different deed asset without overwriting its wallet’s preserved retired aliases', async () => {
    const wallet = manifest.entries[0]!.walletAlias; const mint = randomWallet();
    await db.insert(bases).values({ ownerWallet: wallet, deedAssetId: mint, landPaidAt: new Date(), status: 'inactive' });
    await db.update(players).set({ deedAssetId: mint, entryPaidAt: new Date() }).where(eq(players.wallet, wallet));
    expect(await canPublishWalletDeedAlias(db, wallet)).toBe(false);
    const current = (await deedMetadata.buildDeedMetadataForAsset(db, mint))!;
    expect(current).not.toBeNull();
    // Make the alias builder willing to return a document: protection must be
    // explicit, not incidental to current multi-base ambiguity returning null.
    const alias = vi.spyOn(deedMetadata, 'buildDeedMetadata').mockResolvedValue(current);
    try {
      const writes: string[] = [];
      await sweepDeedMetadata(db, async key => { writes.push(key); }, new Map(), { renderAvailable: false, limit: 100 });
      expect(writes).toContain(`deed/asset/${mint}.json`);
      expect(writes).not.toContain(`deed/${wallet}.json`);
      expect(writes).not.toContain(`deed/${wallet}.png`);
      vi.stubEnv('MULTI_BASE_ENABLED', 'false');
      const visited: string[] = [];
      await sweepDeedMetadata(db, async () => {}, new Map(), { renderAvailable: false, limit: 100, onVisit: id => visited.push(id) });
      expect(visited).not.toContain(mint);
      const chainReads: string[] = [];
      await sweepDeedChain(db, { publicBaseUrl: 'https://example.invalid' }, async () => ({ updated: 0, txs: 0, alreadyCurrent: 0, missing: [] }),
        { limit: 100, published: id => { chainReads.push(id); return null; } });
      expect(chainReads).not.toContain(mint);
    } finally { alias.mockRestore(); vi.stubEnv('MULTI_BASE_ENABLED', 'true'); }
  });

  it('retains additional positive DB exclusions and fails closed if their captured image is missing', async () => {
    const wallet = randomWallet(); const mintId = randomWallet(); const baseId = randomUUID(); const retiredAt = new Date();
    await db.insert(players).values({ wallet });
    await db.insert(bases).values({ id: baseId, ownerWallet: wallet, deedAssetId: mintId, landPaidAt: retiredAt,
      status: 'inactive', createdAt: new Date(retiredAt.getTime() - 1_000) });
    const [receipt] = await db.insert(ledgerTransactions).values({ type: 'retire.scripted-deed',
      idempotencyKey: `retired-extra:${randomUUID()}`, metadata: { wallet }, createdAt: retiredAt }).returning();
    const [abandon] = await db.insert(baseAbandons).values({ playerWallet: wallet, priorKeepLevel: 1, priorExpansions: 0,
      buildingsDeleted: 0, obstaclesTombstoned: 0, jobsDeleted: 0, createdAt: retiredAt }).returning();
    await db.insert(fantasyRetirementExclusions).values({ baseId, mintId, receiptId: receipt!.id,
      abandonReceiptId: abandon!.id, evidenceHash: 'a'.repeat(64) });
    await expect(retiredDeedImageForAsset(db, mintId)).rejects.toThrow('not in the reviewed');
    await expect(retiredDeedImageForWallet(db, wallet)).rejects.toThrow('not in the reviewed');
    const visited: string[] = [];
    await sweepDeedMetadata(db, async () => {}, new Map(), { renderAvailable: false, onVisit: asset => visited.push(asset) });
    expect(visited).not.toContain(mintId);
  });

  it('never falls back to new terrain when the preserved archive is absent', async () => {
    const moved = `${folder}-held`; await fs.rename(folder, moved);
    try {
      const entry = manifest.entries[0]!;
      expect((await app.inject({ url: `/deed/asset/${entry.mintId}.png` })).statusCode).toBe(500);
      expect((await app.inject({ url: `/deed/${entry.walletAlias}.png` })).statusCode).toBe(500);
    } finally { await fs.rename(moved, folder); }
  });

});
