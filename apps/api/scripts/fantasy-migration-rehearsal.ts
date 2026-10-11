/** Rehearse reviewed identity relocation in a new, isolated local database.
 * This imports only the census identity/receipt rows, not a production backup.
 * It does not connect to RPC, R2 or the production database. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sql as query } from 'drizzle-orm';
import { parcelCell, patchCount } from '@shardkeep/shared/parcelGrid';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { fantasyManifestHash, planFantasyMigration, rehearseFantasyMigration, type MigrationIdentity, type RetirementIdentity } from '../src/db/fantasyMigration';
import { buildDeedMetadataForAsset } from '../src/game/deedMetadata';

type Row = Record<string, unknown>;
const evidenceTables = ['bases', 'retirement_abandons', 'slots', 'plots', 'transfers', 'retirement_transactions', 'latest_observations'] as const;
type Snapshot = Record<typeof evidenceTables[number], Row[]> & { snapshot_at: string; transaction_read_only: string };
const [sourceDir] = process.argv.slice(2);
const url = new URL(process.env.DATABASE_URL ?? 'about:blank');
if (!sourceDir || url.hostname !== '127.0.0.1' || url.port !== '55508' || url.pathname !== '/fantasy_rehearsal_test') {
  throw new Error('Requires private census directory and isolated fantasy_rehearsal_test on 127.0.0.1:55508');
}
const source = path.resolve(sourceDir);
const read = async <T>(file: string) => JSON.parse(await fs.readFile(path.join(source, file), 'utf8')) as T;
const snapshot = await read<Snapshot>('production-snapshot.private.json');
const candidates = await read<{ activePaidIdentityVerified: MigrationIdentity[]; activePaidNeedsReview: unknown[]; nonExcludedInactivePaidCohort: MigrationIdentity[] }>('migration-candidates.private.json');
const exclusions = await read<{ exclusions: RetirementIdentity[]; needsReview: unknown[] }>('retirement-exclusions.private.json');
if (snapshot.transaction_read_only !== 'on' || candidates.activePaidNeedsReview.length || exclusions.needsReview.length) {
  throw new Error('Unreviewed census or retirement evidence');
}
for (const key of evidenceTables) {
  if (!Array.isArray(snapshot[key])) throw new Error(`Missing census evidence: ${key}`);
}
const identity = ({ baseId, mintId, ownerWallet }: MigrationIdentity) => ({ baseId, mintId, ownerWallet });
const manifest = planFantasyMigration({ snapshotAt: snapshot.snapshot_at,
  active: candidates.activePaidIdentityVerified.map(identity), inactive: candidates.nonExcludedInactivePaidCohort.map(identity),
  exclusions: exclusions.exclusions.map(({ baseId, mintId, receiptId, abandonReceiptId }) => ({ baseId, mintId, receiptId, abandonReceiptId })) });
const manifestHash = fantasyManifestHash(manifest);
await fs.writeFile(path.join(source, 'migration-manifest.private.json'), JSON.stringify(manifest, null, 2) + '\n');
await fs.writeFile(path.join(source, 'migration-manifest.sha256'), manifestHash + '\n');
process.env.MULTI_BASE_ENABLED = 'true';
process.env.FANTASY_WORLD_ENABLED = 'true';
const connection = createDb(url.toString()); const { db, sql } = connection;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  await runMigrations(db);
  const [existing] = await sql<{ count: number }[]>`select count(*)::int as count from bases`;
  if (existing?.count !== 0) throw new Error('Identity rehearsal requires a fresh empty database; existing data was not changed');
  const wallets = new Set<string>();
  for (const row of snapshot.bases) wallets.add(String(row.owner_wallet));
  for (const row of snapshot.retirement_abandons) wallets.add(String(row.player_wallet));
  for (const row of snapshot.slots) wallets.add(String(row.wallet));
  for (const row of snapshot.plots) if (row.player_wallet) wallets.add(String(row.player_wallet));
  for (const row of snapshot.transfers) { wallets.add(String(row.from_wallet)); wallets.add(String(row.to_wallet)); }
  // Table names and columns are fixed by this import inventory, never sourced
  // from command-line SQL or arbitrary JSON keys.
  await sql.begin(async sql => {
  const insert = async (table: string, columns: string[], rows: Row[]) => {
    for (const row of rows) {
      const values = columns.map(column => row[column]);
      await sql.unsafe(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`, values as never[]);
    }
  };
    // The rehearsal database is disposable and private; no production write
    // credentials or API call are present in this process.
    for (const wallet of wallets) await sql`insert into players(wallet) values (${wallet})`;
    await insert('bases', ['id', 'owner_wallet', 'deed_asset_id', 'deed_mint_asset_id', 'status', 'land_paid_at', 'deed_minting_at',
      'keep_level', 'expansions', 'builders', 'created_at', 'updated_at', 'upgrade_cancel_day', 'research_cancel_day', 'training_cancel_day',
      'upgrade_cancel_count', 'research_cancel_count', 'training_cancel_count'], snapshot.bases);
    await insert('base_transfers', ['id', 'from_wallet', 'to_wallet', 'deed_asset_id', 'created_at', 'jobs_moved', 'buildings_moved', 'shields_moved', 'prior_expansions', 'prior_keep_level', 'prior_entry_paid_at'], snapshot.transfers);
    await insert('base_slots', ['wallet', 'slot', 'base_id', 'active', 'selected_at'], snapshot.slots);
    await insert('ledger_transactions', ['id', 'type', 'idempotency_key', 'created_at', 'metadata'], snapshot.retirement_transactions.map(r => ({ ...r, metadata: JSON.stringify(r.metadata) })));
    await insert('base_abandons', ['id', 'player_wallet', 'prior_keep_level', 'prior_expansions', 'buildings_deleted', 'obstacles_tombstoned', 'jobs_deleted', 'created_at'], snapshot.retirement_abandons);
    await insert('deed_ownership_observations', ['base_id', 'asset_id', 'owner', 'slot', 'checked_at', 'status', 'source', 'audit_hash'], snapshot.latest_observations);
    const valleys = new Set<string>();
    for (const plot of snapshot.plots) {
      if (!valleys.has(String(plot.valley_id))) {
        let site = -1;
        for (let candidate = 0; candidate < patchCount(); candidate++) {
          if (parcelCell(candidate, Number(plot.x), Number(plot.y)) === Number(plot.earth_cell)) { site = candidate; break; }
        }
        if (site < 0) throw new Error('Historical plot does not match its immutable Earth address');
        await sql`insert into valleys(id,name,site_id) values (${String(plot.valley_id)},'Private historical valley',${site})`;
        valleys.add(String(plot.valley_id));
      }
    }
    await insert('plots', ['id', 'base_id', 'player_wallet', 'valley_id', 'x', 'y', 'earth_cell', 'country_a3'], snapshot.plots);
  });
  const unaffected = async () => ({
    bases: await sql`select * from bases order by id`, plots: await sql`select * from plots order by id`,
    slots: await sql`select * from base_slots order by wallet,slot`, accounts: await sql`select * from accounts order by id`,
    buildings: await sql`select * from buildings order by id`, campaign: await sql`select * from base_campaign_progress order by base_id,stage`,
    ledger: await sql`select * from ledger_transactions order by id`,
  });
  const before = hash(await unaffected());
  const retiredBefore = new Map<string, string>();
  for (const row of manifest.exclusions) if (row.mintId) retiredBefore.set(row.mintId, JSON.stringify(await buildDeedMetadataForAsset(db, row.mintId)));
  const first = await rehearseFantasyMigration(db, manifest, manifestHash);
  const second = await rehearseFantasyMigration(db, manifest, manifestHash);
  if (second.inserted !== 0 || second.retained !== first.inserted + first.retained || second.manifestHash !== first.manifestHash) {
    throw new Error('Rehearsal rerun was not idempotent');
  }
  const after = hash(await unaffected());
  if (before !== after) throw new Error('Rehearsal mutated imported identity or gameplay/financial tables');
  for (const [mint, document] of retiredBefore) if (JSON.stringify(await buildDeedMetadataForAsset(db, mint)) !== document) throw new Error('Retired metadata changed');
  const counts = await db.execute(query`select state,count(*)::int as count from fantasy_land_claims group by state order by state`);
  const report = { kind: 'census identity rehearsal; not a full production backup', manifestHash, first, second,
    counts, importedStateHashBefore: before, importedStateHashAfter: after,
    retiredDocumentsUnchanged: retiredBefore.size, productionWrites: 0, publicUploads: 0, chainTransactions: 0,
    completedAt: new Date().toISOString() };
  await fs.writeFile(path.join(source, 'rehearsal-receipt.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await sql.end(); }
