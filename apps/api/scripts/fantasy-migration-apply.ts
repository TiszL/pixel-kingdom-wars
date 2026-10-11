/** Explicit, reusable release operator. Default is a full transactional dry run.
 * This script does not deploy, refresh ownership, publish metadata or call RPC.
 * Refresh finalized ownership using the normal observer immediately beforehand;
 * the same migration core rejects stale/mismatched evidence for new assignments.
 * With --apply it atomically assigns the reviewed deeds, stages issued Earth
 * payments, and closes new Earth sales. Enabling native sales is a later step. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createDb } from '../src/db/client';
import { applyFantasyMigration, fantasyManifestHash, validateFantasyManifest, type FantasyMigrationManifest } from '../src/db/fantasyMigration';
import { assertFantasyMigrationOperator, parseFantasyMigrationOperatorArgs } from '../src/db/fantasyMigrationOperator';
import { BUILD } from '../src/version';

const options = parseFantasyMigrationOperatorArgs(process.argv.slice(2));
const manifest = JSON.parse(await fs.readFile(options.manifestPath, 'utf8')) as FantasyMigrationManifest;
validateFantasyManifest(manifest);
let gitSha: string | null = null; let gitDirty = false;
try {
  gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  gitDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
} catch { if (gitSha) throw new Error('Could not verify checkout integrity'); }
assertFantasyMigrationOperator(options, {
  manifestHash: fantasyManifestHash(manifest), buildSha: BUILD.gitSha, gitSha, gitDirty,
  fantasyEnabled: process.env.FANTASY_WORLD_ENABLED, multiBaseEnabled: process.env.MULTI_BASE_ENABLED,
});
if (!process.env.DATABASE_URL) throw new Error('Explicit DATABASE_URL is required');
const conn = createDb(process.env.DATABASE_URL);
try {
  const receipt = await applyFantasyMigration(conn.db, manifest, options.expectedManifestHash, { dryRun: !options.apply });
  // Aggregate receipt only. Private base/mint identities stay in the manifest.
  console.log(JSON.stringify({ ...receipt, buildSha: options.expectedBuildSha, checkoutDirty: gitDirty,
    mode: options.apply ? 'applied' : 'dry-run-rolled-back', completedAt: new Date().toISOString() }, null, 2));
} finally { await conn.sql.end(); }
