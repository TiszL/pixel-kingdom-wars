import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { charterAssetPda, charterClanIdBytes, charterConfigPda, charterCreationPda, charterExecutorPda,
  charterFreezePda, charterMintPda, charterPda, hashCharterMetadata } from '../charterProtocol';
import { createCharterCreationEvidenceReader, type CharterCreationSavedRecord, type CharterCreationEvidenceTrust,
  type CharterCreationEvidenceRpc } from '../charterCreationEvidence';

// Explicit synthetic B6g wire fixtures, not a claim of RPC/Core execution. The
// layouts also have independent Rust/Anchor and actual-Core acceptance coverage.
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const SYSVAR = new PublicKey('Sysvar1111111111111111111111111111111111111');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const str = (v: string) => Buffer.concat([u32(Buffer.byteLength(v)), Buffer.from(v)]);
const discriminator = (v: string) => createHash('sha256').update(`account:${v}`).digest().subarray(0, 8);
const clanId = '12345678-1234-5678-9abc-def012345678', intent = '87654321-4321-4321-8abc-def012345678';
function fixture() {
  const economy = key(8), craft = key(9), payer = key(10), genesis = key(11), admin = key(12);
  const pd = (p: PublicKey) => PublicKey.findProgramAddressSync([p.toBuffer()], LOADER)[0];
  const derive = (p: PublicKey, seed: string, ...tails: Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...tails], p);
  const c = charterClanIdBytes(clanId), id = charterClanIdBytes(intent);
  const craftPda = (seed: string) => derive(craft, seed)[0];
  const asset = charterMintPda(craft, clanId), collection = craftPda('charter_collection'), ca = craftPda('charter_collection_authority');
  const name = 'First Charter', uri = 'https://invalid.example/charter.json';
  const metadata = { name, uri, hash: hashCharterMetadata({ name, uri }).toString('hex') };
  const saved: CharterCreationSavedRecord = { creationIntentId: intent, clanId, payer: payer.toBase58(), metadata,
    chain: { genesisHash: genesis.toBase58(), economyProgram: economy.toBase58(), craftProgram: craft.toBase58(),
      config: charterConfigPda(economy).toBase58(), craftControl: craftPda('charter_control').toBase58(),
      collection: collection.toBase58(), collectionAuthority: ca.toBase58(), charter: charterPda(economy, clanId).toBase58(),
      asset: asset.toBase58(), assetBinding: charterAssetPda(economy, asset).toBase58(), freezeAuthority: charterFreezePda(craft, clanId).toBase58(),
      executor: charterExecutorPda(economy, clanId).toBase58(), creationReceipt: charterCreationPda(economy, intent).toBase58() },
    admissionCommitment: 'ab'.repeat(32), issuedPermitIds: ['00'.repeat(16), 'cd'.repeat(16)] };
  const b = (field: keyof typeof saved.chain) => new PublicKey(saved.chain[field]).toBuffer();
  const row = (address: PublicKey, owner: PublicKey, data: Buffer, executable = false) => ({ address, owner, data, executable });
  const rows: ReturnType<typeof row>[] = [];
  const deployment = (programId: PublicKey, n: number) => {
    const program = Buffer.concat([u32(2), pd(programId).toBuffer()]);
    const programData = Buffer.concat([u32(3), u64(90n), Buffer.of(1), admin.toBuffer(), Buffer.alloc(17, n)]);
    rows.push(row(programId, LOADER, program, true), row(pd(programId), LOADER, programData));
    return { programId: programId.toBase58(), reviewedDeploymentSlot: 90, reviewedProgramDataSha256: sha(programData), upgradeAuthority: admin.toBase58() };
  };
  const trust: CharterCreationEvidenceTrust = { expectedGenesisHash: genesis.toBase58(), economy: deployment(economy, 1),
    craft: deployment(craft, 2), core: deployment(CORE, 3), stateProvenance: 'fresh-reviewed-deployment' };
  const acc = (label: string, name: string, data: Buffer, owner = economy) => rows.push(row(new PublicKey(saved.chain[label as keyof typeof saved.chain]), owner,
    Buffer.concat([discriminator(name), Buffer.of(1), data])));
  acc('config', 'CharterConfig', Buffer.concat([derive(economy, 'seeker_authority')[0].toBuffer(), craft.toBuffer(), b('craftControl'), b('collection'), b('collectionAuthority'), Buffer.of(derive(economy, 'charter_config')[1])]));
  acc('craftControl', 'CharterControl', Buffer.concat([admin.toBuffer(), economy.toBuffer(), b('collection'), b('collectionAuthority'), Buffer.of(0,
    derive(craft, 'charter_control')[1], derive(craft, 'charter_collection')[1], derive(craft, 'charter_collection_authority')[1])]), craft);
  acc('charter', 'ClanCharter', Buffer.concat([b('config'), c, b('asset'), b('collection'), payer.toBuffer(), u32(0), Buffer.of(1, 0), Buffer.alloc(16), id,
    Buffer.from(metadata.hash, 'hex'), Buffer.from(saved.admissionCommitment, 'hex'), Buffer.from(saved.issuedPermitIds[0]!, 'hex'), u64(1_800_000_000n), Buffer.of(derive(economy, 'charter', c)[1])]));
  acc('creationReceipt', 'CharterCreationReceipt', Buffer.concat([id, c, b('charter'), b('asset'), payer.toBuffer(), Buffer.from(saved.issuedPermitIds[0]!, 'hex'), Buffer.of(derive(economy, 'charter_creation', id)[1])]));
  acc('assetBinding', 'CharterAssetBinding', Buffer.concat([b('asset'), c, b('charter'), Buffer.of(derive(economy, 'charter_asset', asset.toBuffer())[1])]));
  const base = Buffer.concat([Buffer.of(1), payer.toBuffer(), Buffer.of(2), collection.toBuffer(), str(name), str(uri), Buffer.of(0)]);
  const pluginAt = base.length + 9, registryAt = pluginAt + 2;
  rows.push(row(asset, CORE, Buffer.concat([base, Buffer.of(3), u64(BigInt(registryAt)), Buffer.of(5, 1, 4), u32(1), Buffer.of(5, 3), b('freezeAuthority'), u64(BigInt(pluginAt)), u32(0)])));
  rows.push(row(collection, CORE, Buffer.concat([Buffer.of(5), ca.toBuffer(), str('Shared Charter collection'), str(uri), u32(4), u32(4)])));
  const clock = Buffer.alloc(40); clock.writeBigUInt64LE(150n); clock.writeBigInt64LE(1_800_000_010n, 32);
  rows.push(row(SYSVAR_CLOCK_PUBKEY, SYSVAR, clock));
  const rpc: CharterCreationEvidenceRpc = { getGenesisHash: async () => genesis.toBase58(), getSlot: async () => 150,
    getMultipleAccountsInfoAndContext: vi.fn(async (addresses: PublicKey[]) => ({ context: { slot: 150 }, value: addresses.map(p => rows.find(r => r.address.equals(p)) ?? null) })) };
  const get = (label: keyof typeof saved.chain) => rows.find(r => r.address.toBase58() === saved.chain[label])!;
  const load = vi.fn(async () => saved);
  const read = () => createCharterCreationEvidenceReader(() => rpc, trust, load);
  return { saved, trust, rpc, rows, get, read, load, pluginAt, registryAt, baseEnd: base.length, admin, genesis };
}


export { fixture, key, sha, clanId, intent };
