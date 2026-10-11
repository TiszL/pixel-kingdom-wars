/** Synthetic finalized bytes for an authentic SQL migration original. No funded
 * reservation, fake creation ledger, policy attempt or terminal is inserted. */
import {createHash} from 'node:crypto';
import {AddressLookupTableProgram,Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {vi} from 'vitest';
import {PHASE_E_CHARTER_ADMISSION} from '@shardkeep/shared';
import {charterClanIdBytes} from '@shardkeep/chain/charter-protocol';
import type {CharterCreationEvidenceRpc,CharterCreationEvidenceTrust} from '@shardkeep/chain/charter-creation-evidence';
import {createCharterCreationQuoteReader,type CharterCreationQuoteRpc} from '@shardkeep/chain/charter-creation-preparation';
import {candidateFor,lookupFixture} from '../../../../packages/chain/src/testFixtures/charterPreparation';
import type {MigrationState} from '../../src/db/charterMigrations';
export const MIGRATION_CLOCK=1_800_000_010n;
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const SYSVAR = new PublicKey('Sysvar1111111111111111111111111111111111111');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const str = (v: string) => Buffer.concat([u32(Buffer.byteLength(v)), Buffer.from(v)]);
const discriminator = (v: string) => createHash('sha256').update(`account:${v}`).digest().subarray(0, 8);

export function migrationBank(saved: Pick<MigrationState,'original'|'inventory'>, policy=Keypair.generate(), minted = false) {
  const original = saved.original, chain = original.chain;
  const key = (field: keyof typeof chain) => new PublicKey(chain[field]);
  const b = (field: keyof typeof chain) => key(field).toBuffer();
  const economy = key('economyProgram'), craft = key('craftProgram'), payer = new PublicKey(original.payer);
  const admin = new PublicKey(Buffer.alloc(32, 17));
  const derive = (p: PublicKey, seed: string, ...tails: Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...tails], p);
  const pd = (p: PublicKey) => PublicKey.findProgramAddressSync([p.toBuffer()], LOADER)[0];
  const row = (address: PublicKey, owner: PublicKey, data: Buffer, executable = false) => ({ address, owner, data, executable });
  const rows: ReturnType<typeof row>[] = [];
  const deployment = (programId: PublicKey, n: number) => {
    const programData = Buffer.concat([u32(3), u64(90n), Buffer.of(1), admin.toBuffer(), Buffer.alloc(17, n)]);
    rows.push(row(programId, LOADER, Buffer.concat([u32(2), pd(programId).toBuffer()]), true), row(pd(programId), LOADER, programData));
    return { programId: programId.toBase58(), reviewedDeploymentSlot: 90, reviewedProgramDataSha256: sha(programData), upgradeAuthority: admin.toBase58() };
  };
  const trust: CharterCreationEvidenceTrust = { expectedGenesisHash: chain.genesisHash, economy: deployment(economy, 1),
    craft: deployment(craft, 2), core: deployment(CORE, 3), stateProvenance: 'fresh-reviewed-deployment' };
  const account = (field: keyof typeof chain, name: string, bytes: Buffer, owner = economy) =>
    row(key(field), owner, Buffer.concat([discriminator(name), Buffer.of(1), bytes]));
  rows.push(account('config', 'CharterConfig', Buffer.concat([derive(economy, 'seeker_authority')[0].toBuffer(), craft.toBuffer(),
    b('craftControl'), b('collection'), b('collectionAuthority'), Buffer.of(derive(economy, 'charter_config')[1])])));
  rows.push(account('craftControl', 'CharterControl', Buffer.concat([admin.toBuffer(), economy.toBuffer(), b('collection'),
    b('collectionAuthority'), Buffer.of(0, derive(craft, 'charter_control')[1], derive(craft, 'charter_collection')[1],
      derive(craft, 'charter_collection_authority')[1])]), craft));
  const clan = charterClanIdBytes(original.clanId), intent = charterClanIdBytes(original.creationIntentId);
  // An unrecorded permit deliberately cannot authenticate a mint for a zero head.
  const permit = Buffer.from(saved.inventory.messages[0]?.slice(146,178) ?? '00'.repeat(16), 'hex');
  const creationRows = [
    account('charter', 'ClanCharter', Buffer.concat([b('config'), clan, b('asset'), b('collection'), payer.toBuffer(), u32(0),
      Buffer.of(1, 0), Buffer.alloc(16), intent, Buffer.from(original.metadata.hash, 'hex'), Buffer.from(original.admissionCommitment, 'hex'),
      permit, u64(MIGRATION_CLOCK), Buffer.of(derive(economy, 'charter', clan)[1])])),
    account('creationReceipt', 'CharterCreationReceipt', Buffer.concat([intent, clan, b('charter'), b('asset'), payer.toBuffer(), permit,
      Buffer.of(derive(economy, 'charter_creation', intent)[1])])),
    account('assetBinding', 'CharterAssetBinding', Buffer.concat([b('asset'), clan, b('charter'),
      Buffer.of(derive(economy, 'charter_asset', b('asset'))[1])])),
  ];
  const base = Buffer.concat([Buffer.of(1), payer.toBuffer(), Buffer.of(2), b('collection'), str(original.metadata.name), str(original.metadata.uri), Buffer.of(0)]);
  const pluginAt = base.length + 9;
  creationRows.push(row(key('asset'), CORE, Buffer.concat([base, Buffer.of(3), u64(BigInt(pluginAt + 2)), Buffer.of(5, 1, 4),
    u32(1), Buffer.of(5, 3), b('freezeAuthority'), u64(BigInt(pluginAt)), u32(0)])));
  rows.push(row(key('collection'), CORE, Buffer.concat([Buffer.of(5), b('collectionAuthority'), str('Shared Charter collection'),
    str(original.metadata.uri), u32(1), u32(1)])));
  const clock = Buffer.alloc(40); clock.writeBigUInt64LE(150n); clock.writeBigInt64LE(MIGRATION_CLOCK, 32);
  rows.push(row(SYSVAR_CLOCK_PUBKEY, SYSVAR, clock));
  const setMinted = (present: boolean) => {
    for (const entry of creationRows) { const i = rows.indexOf(entry); if (i >= 0) rows.splice(i, 1); }
    if (present) rows.push(...creationRows);
  };
  setMinted(minted);
  const rpc: CharterCreationEvidenceRpc = { getGenesisHash: vi.fn(async () => chain.genesisHash), getSlot: vi.fn(async () => 150),
    getMultipleAccountsInfoAndContext: vi.fn(async (addresses: PublicKey[]) => ({ context: { slot: 150 },
      value: addresses.map(address => rows.find(entry => entry.address.equals(address)) ?? null) })) };
  const authority=PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')],economy),authorityData=Buffer.alloc(213);
  Buffer.concat([discriminator('SeekerAuthority'),Buffer.of(1),admin.toBuffer(),Buffer.of(0),admin.toBuffer(),policy.publicKey.toBuffer(),Buffer.of(0),u64(0n),key('genesisHash').toBuffer(),Buffer.of(0,authority[1])]).copy(authorityData);
  rows.push(row(authority[0],economy,authorityData));
  const candidate=candidateFor(original,MIGRATION_CLOCK+BigInt(PHASE_E_CHARTER_ADMISSION.v1.issuedPermitTtlSec)),lookup=lookupFixture(original,candidate),blockhash=Keypair.generate().publicKey.toBase58();
  const quoteRpc:CharterCreationQuoteRpc={...rpc,getAccountInfoAndContext:vi.fn(async()=>({context:{slot:150},value:{owner:AddressLookupTableProgram.programId,executable:false,data:lookup.data}})),
   getLatestBlockhashAndContext:vi.fn(async()=>({context:{slot:150},value:{blockhash,lastValidBlockHeight:300}})),getFeeForMessage:vi.fn(async()=>({context:{slot:150},value:10000})),
   getMinimumBalanceForRentExemption:vi.fn(async n=>1000+n*5),getBlockHeight:vi.fn(async()=>200)};
  const connect=vi.fn((_signal:AbortSignal)=>quoteRpc),options={trust,expectedCurrentSigner:policy.publicKey.toBase58(),lookupTable:lookup.pin,
   coreCostProfile:{version:1 as const,profile:'mpl-core-0.15.2-charter-pfd-seq-none' as const,reviewedProgramDataSha256:trust.core.reviewedProgramDataSha256},
   costLimits:{maxNetworkFeeLamports:100000n,maxRentLamports:100000n,maxTotalLamports:2000000n}};
  const quote=()=>createCharterCreationQuoteReader(connect,options)(original,candidate);
  return {trust,rpc:quoteRpc,connect,rows,creationRows,clock,setMinted,policy,authorityData,setPaused:(paused:boolean)=>{authorityData[147]=paused?1:0;},candidate,lookup,options,quote,chain:{connect,...options}};
}
