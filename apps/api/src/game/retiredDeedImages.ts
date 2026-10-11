/** Audited archive identities and positive DB exclusions retain their original images.
 * Never send an excluded deed through the current terrain renderer. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { fantasyRetirementExclusions, ledgerTransactions } from '../db/schema';
import { RETIRED_ARCHIVE_MANIFEST_SHA256, preservedRetiredDeedForMint, preservedRetiredDeedForWallet } from './retiredDeedPreservation';

interface ArchivedResponse {
  status: 200 | 404; sha256: string; bytes: number; contentType: string;
  file?: string; body?: string;
}
interface ArchiveEntry { mintId: string; walletAlias: string; asset: ArchivedResponse; wallet: ArchivedResponse }
interface ArchiveManifest { version: 1; entries: ArchiveEntry[] }
export interface RetiredImageResponse { status: 200 | 404; contentType: string; body: Buffer }

async function archivedResponse(mintId: string, kind: 'asset' | 'wallet', wallet?: string): Promise<RetiredImageResponse> {
  const root = process.env['REPO_ROOT'] ?? path.resolve(process.cwd(), '..', '..');
  const folder = path.join(root, 'apps/web/public/atlas/retired-deeds');
  const bytes = await readFile(path.join(folder, 'manifest.json'));
  const digest = (await readFile(path.join(folder, 'manifest.sha256'), 'utf8')).trim();
  if (digest !== RETIRED_ARCHIVE_MANIFEST_SHA256 || createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Retired deed image manifest integrity failure');
  const manifest = JSON.parse(bytes.toString('utf8')) as ArchiveManifest;
  const entry = manifest.entries.find(row => row.mintId === mintId);
  if (manifest.version !== 1 || !entry || (wallet !== undefined && entry.walletAlias !== wallet)) {
    throw new Error('Excluded deed image is not in the reviewed preservation archive');
  }
  const response = entry[kind];
  if (![200, 404].includes(response.status) || !/^[a-f0-9]{64}$/.test(response.sha256)) throw new Error('Invalid retired deed image receipt');
  let body: Buffer;
  if (response.status === 200) {
    if (response.file !== `${mintId}-${kind}.png` || response.contentType !== 'image/png') throw new Error('Invalid retired deed image filename');
    body = await readFile(path.join(folder, response.file));
  } else {
    if (typeof response.body !== 'string') throw new Error('Missing retired deed not-found response');
    body = Buffer.from(response.body);
  }
  if (body.length !== response.bytes || createHash('sha256').update(body).digest('hex') !== response.sha256) {
    throw new Error('Retired deed image bytes differ from the captured original');
  }
  return { status: response.status, contentType: response.contentType, body };
}

export async function retiredDeedImageForAsset(db: DbOrTx, mintId: string): Promise<RetiredImageResponse | null> {
  if (preservedRetiredDeedForMint(mintId)) return archivedResponse(mintId, 'asset');
  const [excluded] = await db.select({ mintId: fantasyRetirementExclusions.mintId }).from(fantasyRetirementExclusions)
    .where(eq(fantasyRetirementExclusions.mintId, mintId));
  return excluded ? archivedResponse(mintId, 'asset') : null;
}

export async function retiredDeedImageForWallet(db: DbOrTx, wallet: string): Promise<RetiredImageResponse | null> {
  const preserved = preservedRetiredDeedForWallet(wallet);
  if (preserved) return archivedResponse(preserved.mintId, 'wallet', wallet);
  const exclusions = await db.select({ mintId: fantasyRetirementExclusions.mintId }).from(fantasyRetirementExclusions)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, fantasyRetirementExclusions.receiptId))
    .where(sql`${ledgerTransactions.metadata}->>'wallet'=${wallet}`);
  const minted = exclusions.filter(row => row.mintId !== null);
  if (minted.length === 0) return null;
  if (minted.length !== 1) throw new Error('Retired wallet image identity requires reconciliation');
  return archivedResponse(minted[0]!.mintId!, 'wallet', wallet);
}
