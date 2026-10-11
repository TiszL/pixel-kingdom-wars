/** Explicit synthetic finalized absence bank for pairing the actual DB loader
 * with B6k. No RPC, finality, policy signature or natural elapsed-time claim. */
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import type { CharterCreationEvidenceRpc, CharterCreationEvidenceTrust } from '@shardkeep/chain/charter-creation-evidence';
import type { CharterCreationConsent } from '../../src/game/clanCharterCreationConsent';
import { sha } from './charterPermitInventory';
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const SYSVAR = new PublicKey('Sysvar1111111111111111111111111111111111111');
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
const disc = (s: string) => createHash('sha256').update('account:' + s).digest().subarray(0, 8);
export function charterPermitCancellationBank(consent: CharterCreationConsent, now: bigint) {
  const rows: Array<{ address: PublicKey; owner: PublicKey; executable: boolean; data: Buffer }> = [];
  const c = consent.chain, economy = new PublicKey(c.economyProgram), craft = new PublicKey(c.craftProgram), admin = Keypair.generate().publicKey;
  const p = (field: keyof typeof c) => new PublicKey(c[field]);
  const derive = (program: PublicKey, seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], program);
  const deployment = (program: PublicKey) => {
    const dataAddress = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];
    const data = Buffer.concat([u32(3), u64(90n), Buffer.of(1), admin.toBuffer(), Buffer.of(1, 2, 3)]);
    rows.push({ address: program, owner: LOADER, executable: true, data: Buffer.concat([u32(2), dataAddress.toBuffer()]) },
      { address: dataAddress, owner: LOADER, executable: false, data });
    return { programId: program.toBase58(), reviewedDeploymentSlot: 90, reviewedProgramDataSha256: sha(data), upgradeAuthority: admin.toBase58() };
  };
  const trust: CharterCreationEvidenceTrust = { expectedGenesisHash: c.genesisHash, economy: deployment(economy), craft: deployment(craft),
    core: deployment(CORE), stateProvenance: 'fresh-reviewed-deployment' };
  rows.push({ address: p('config'), owner: economy, executable: false, data: Buffer.concat([disc('CharterConfig'), Buffer.of(1),
    derive(economy, 'seeker_authority')[0].toBuffer(), craft.toBuffer(), p('craftControl').toBuffer(), p('collection').toBuffer(),
    p('collectionAuthority').toBuffer(), Buffer.of(derive(economy, 'charter_config')[1])]) });
  rows.push({ address: p('craftControl'), owner: craft, executable: false, data: Buffer.concat([disc('CharterControl'), Buffer.of(1),
    admin.toBuffer(), economy.toBuffer(), p('collection').toBuffer(), p('collectionAuthority').toBuffer(),
    Buffer.of(1, derive(craft, 'charter_control')[1], derive(craft, 'charter_collection')[1], derive(craft, 'charter_collection_authority')[1])]) });
  rows.push({ address: p('collection'), owner: CORE, executable: false,
    data: Buffer.concat([Buffer.of(5), p('collectionAuthority').toBuffer(), str('Charter fixture'), str('https://invalid.example/collection'), u32(0), u32(0)]) });
  const clock = Buffer.alloc(40); clock.writeBigUInt64LE(150n); clock.writeBigInt64LE(now, 32);
  rows.push({ address: SYSVAR_CLOCK_PUBKEY, owner: SYSVAR, executable: false, data: clock });
  const rpc: CharterCreationEvidenceRpc = { getGenesisHash: async () => c.genesisHash, getSlot: async () => 150,
    getMultipleAccountsInfoAndContext: async addresses => ({ context: { slot: 150 }, value: addresses.map(k => rows.find(r => r.address.equals(k)) ?? null) }) };
  return { trust, rpc, clock };
}
