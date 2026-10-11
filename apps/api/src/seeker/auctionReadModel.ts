/** Read-only live auction evidence. Every batch must come from one finalized
 * bank; bounded retries may restart a moving bank, without a zero-state
 * fallback. Completed rows here are not historical settlement provenance. */
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { keepAta } from '@shardkeep/chain';
import { canonicalSeekerRegistry, hashSeekerRegistry, seekerAuctionConfigPda, seekerAuctionPda,
  seekerAuthorityPda, seekerBidPda, seekerRegistryPda, seekerTermPda, type SeekerAuctionTerms } from '@shardkeep/chain/seeker-auction-protocol';
import { decodeSeekerAuctionConfig, decodeSeekerLiveTerm, decodeSeekerLiveAuction, decodeSeekerLiveBid,
  decodeSeekerAuthority, decodeUpgradeableProgramDataAddress, decodeProgramDataUpgradeAuthority, seekerBiddingRoundAt,
  SEEKER_TERM_ACCOUNT_BYTES, type SeekerRawAccount, type SeekerLiveAuctionConfig, type SeekerLiveTerm,
  type SeekerLiveAuction, type SeekerLiveBid, type SeekerAuthorityFacts } from '@shardkeep/chain/seeker-auction-live';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION_RUNTIME } from '@shardkeep/shared';
import { SeekerAuctionSourcedRoundViewSchema, type SeekerAuctionSourcedRoundView } from '@shardkeep/shared/seekerAuctionApi';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';

const P = PHASE_E_POLICY.seekerIsland, R = PHASE_E_SEEKER_AUCTION_RUNTIME;
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const SYSVAR_OWNER = new PublicKey('Sysvar1111111111111111111111111111111111111');
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n, U64_MAX = (1n << 64n) - 1n;
// RPC work bounds and classic SPL ABI sizes, not economy tuning.
const READ_DEADLINE_MS = 30_000, RPC_BATCH_MAX = 100, MINT_BYTES = 82, TOKEN_ACCOUNT_BYTES = 165;
/** K-night-08 multi-node pool bounds (RPC work, not economy tuning): forward bank
 * movements one read may re-validate, and short waits for a pool node that is
 * still below the requested context floor (JSON-RPC -32016). All share the deadline. */
export const SEEKER_AUCTION_BANK_ADVANCE_MAX = 8, SEEKER_AUCTION_NODE_BEHIND_RETRY_MAX = 5, SEEKER_AUCTION_NODE_BEHIND_WAIT_MS = 200;
const CLOCK_KEY = SYSVAR_CLOCK_PUBKEY.toBase58();
// state.rs uses Anchor's unoverridden #[account] discriminator for this type.
const REGISTRY_DISCRIMINATOR = createHash('sha256').update('account:SeekerRegistry').digest().subarray(0, 8);
/** Minimum read capability, also implemented by the dedicated issuer's
 * existing transport. Lamports/rentEpoch are not auction evidence. */
export interface SeekerAuctionReadRpc {
  getGenesisHash():Promise<string>;
  getMultipleAccountsInfoAndContext(addresses:PublicKey[],options:{commitment:'finalized';minContextSlot:number}):Promise<{
    context:{slot:number};value:readonly(Readonly<{owner:PublicKey;executable:boolean;data:Uint8Array}>|null)[];
  }>;
}
export interface SeekerAuctionReadTrust {
  readonly programId: string; readonly genesisHash: string; readonly mint: string; readonly prizeOwner: string; readonly decimals: number;
  readonly deploymentSlot: number; readonly programDataSha256: string; readonly upgradeAuthority: string | null;
  readonly stateProvenance: 'fresh-reviewed-deployment';
}
export interface SeekerAuctionReadSource {
  readonly connect: (signal: AbortSignal) => SeekerAuctionReadRpc;
  readonly trust: SeekerAuctionReadTrust;
}
export interface SeekerAuctionReadResult {
  readonly view: SeekerAuctionSourcedRoundView; readonly config: SeekerLiveAuctionConfig; readonly term: SeekerLiveTerm | null;
  readonly auctions: readonly (SeekerLiveAuction | null)[]; readonly bids: readonly (SeekerLiveBid | null)[];
  readonly walletAta: Readonly<{ address: string; amount: bigint }> | null; readonly nowSec: bigint; readonly slot: number;
  readonly authority: SeekerAuthorityFacts;
}
/** Re-derive immutable kind-7 terms from an admitted finalized bank. This helper
 * has no signing authority; issuer/crank admission remains separately required. */
export function seekerAuctionTermsFromRead(state:SeekerAuctionReadResult,spot:number):SeekerAuctionTerms {
 const c=state.config,t=state.term,entry=canonicalSeekerRegistry()[spot];need(t&&entry&&Number.isInteger(spot),'open terms target');
 const program=new PublicKey(c.programId),config=new PublicKey(c.address),auction=seekerAuctionPda(program,config,spot,t.round),mint=new PublicKey(c.mint);
 return {...entry,config,term:new PublicKey(t.address),auction,registry:new PublicKey(c.registry),registryHash:Buffer.from(c.registryHash,'hex'),round:t.round,
  auctionStart:t.auctionStart,auctionEnd:t.auctionEnd,operatingStart:t.operatingStart,operatingEnd:t.operatingEnd,mint,tokenProgram:new PublicKey(c.tokenProgram),vault:keepAta(auction,mint,true),
  prizeOwner:new PublicKey(c.prizeOwner),prizeAta:new PublicKey(c.prizeAta),prizeBps:c.prizeBps,grace:c.graceSec,openingBid:c.openingBid,
  registryVersion:c.registryVersion,auctionFormat:c.auctionFormat,termsFormat:c.termsFormat};
}
function need(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Seeker auction evidence unavailable: ${label}`);
}
function address(value: string): PublicKey {
  need(typeof value === 'string', 'address type');
  const result = new PublicKey(value); need(result.toBase58() === value && !result.equals(PublicKey.default), 'canonical address'); return result;
}
function safeSlot(value: number): number { need(Number.isSafeInteger(value) && value >= 0, 'RPC context slot'); return value; }
function signed(value: bigint): bigint { need(value >= I64_MIN && value <= I64_MAX, 'calendar overflow'); return value; }
function required(value: SeekerRawAccount | null | undefined): SeekerRawAccount { need(value, 'missing required account'); return value; }
function snapshotTrust(value: SeekerAuctionReadTrust): SeekerAuctionReadTrust {
  need(value && value.stateProvenance === 'fresh-reviewed-deployment', 'unreviewed state provenance');
  need(Number.isInteger(value.decimals) && value.decimals >= 0 && value.decimals <= 255, 'mint decimal pin');
  safeSlot(value.deploymentSlot); need(/^[0-9a-f]{64}$/.test(value.programDataSha256), 'deployment hash pin');
  need(Object.hasOwn(value, 'upgradeAuthority') && (value.upgradeAuthority === null || typeof value.upgradeAuthority === 'string'), 'explicit upgrade authority pin');
  return Object.freeze({ programId: address(value.programId).toBase58(), genesisHash: address(value.genesisHash).toBase58(),
    mint: address(value.mint).toBase58(), prizeOwner: address(value.prizeOwner).toBase58(), decimals: value.decimals,
    deploymentSlot: value.deploymentSlot, programDataSha256: value.programDataSha256,
    upgradeAuthority: value.upgradeAuthority === null ? null : address(value.upgradeAuthority).toBase58(), stateProvenance: value.stateProvenance });
}
function verifyDeployment(program: SeekerRawAccount, programData: SeekerRawAccount, trust: SeekerAuctionReadTrust, slot: number): void {
  const canonical = PublicKey.findProgramAddressSync([new PublicKey(trust.programId).toBuffer()], LOADER)[0];
  need(program.address.toBase58() === trust.programId && program.executable === true && program.owner.equals(LOADER)
    && programData.address.equals(canonical) && decodeUpgradeableProgramDataAddress(Buffer.from(program.data)).equals(canonical), 'program identity');
  need(programData.executable === false && programData.owner.equals(LOADER)
    && createHash('sha256').update(programData.data).digest('hex') === trust.programDataSha256, 'reviewed ProgramData changed');
  const data = Buffer.from(programData.data), authority = decodeProgramDataUpgradeAuthority(data);
  need((authority?.toBase58() ?? null) === trust.upgradeAuthority && data.readBigUInt64LE(4) === BigInt(trust.deploymentSlot)
    && trust.deploymentSlot <= slot, 'deployment authority/slot');
}
function verifyRegistry(raw: SeekerRawAccount, config: SeekerLiveAuctionConfig): void {
  const program = new PublicKey(config.programId), [registry, bump] = PublicKey.findProgramAddressSync([Buffer.from('seeker_registry')], program);
  need(raw.address.equals(registry) && raw.address.toBase58() === config.registry && raw.owner.equals(program)
    && raw.executable === false && raw.data.length === SEEKER_TERM_ACCOUNT_BYTES.SeekerRegistry, 'registry identity/allocation');
  const data = Buffer.from(raw.data), entries = canonicalSeekerRegistry();
  need(data.subarray(0, 8).equals(REGISTRY_DISCRIMINATOR) && data.readUInt16LE(8) === config.registryVersion && data[10] === 1, 'registry discriminator/version');
  let at = 11;
  for (const entry of entries) {
    need(data[at++] === entry.spotId && data[at++] === entry.class && data[at++] === entry.realmMask, 'registry mapping');
  }
  need(data.subarray(at, at + 32).toString('hex') === config.registryHash
    && hashSeekerRegistry(entries).toString('hex') === config.registryHash && data[at + 32] === bump, 'registry hash/bump');
}
function tokenAccount(raw: SeekerRawAccount, tokenProgram: string, size: number): Buffer {
  need(raw.owner.toBase58() === tokenProgram && raw.executable === false && raw.data.length === size, 'classic SPL account identity/allocation');
  return Buffer.from(raw.data);
}
function option32(data: Buffer, at: number): void { const tag = data.readUInt32LE(at); need(tag === 0 || tag === 1, 'SPL COption tag'); }
function verifyMint(raw: SeekerRawAccount, config: SeekerLiveAuctionConfig): void {
  need(raw.address.toBase58() === config.mint, 'mint address'); const data = tokenAccount(raw, config.tokenProgram, MINT_BYTES);
  option32(data, 0); option32(data, 46); need(data[44] === config.decimals && data[45] === 1, 'mint decimals/initialization');
}
function readWalletAta(raw: SeekerRawAccount | null, expected: PublicKey, wallet: PublicKey,
  config: SeekerLiveAuctionConfig): SeekerAuctionReadResult['walletAta'] {
  if (raw === null) return null;
  need(raw.address.equals(expected), 'wallet ATA address'); const data = tokenAccount(raw, config.tokenProgram, TOKEN_ACCOUNT_BYTES);
  need(new PublicKey(data.subarray(0, 32)).toBase58() === config.mint
    && new PublicKey(data.subarray(32, 64)).equals(wallet) && data[108] === 1, 'wallet ATA owner/mint/state');
  option32(data, 72); option32(data, 109); option32(data, 129);
  return Object.freeze({ address: expected.toBase58(), amount: data.readBigUInt64LE(64) });
}
function actualClock(raw: SeekerRawAccount, slot: number): bigint {
  need(raw.address.equals(SYSVAR_CLOCK_PUBKEY) && raw.owner.equals(SYSVAR_OWNER) && raw.executable === false && raw.data.length === 40, 'actual Clock identity');
  const data = Buffer.from(raw.data); need(data.readBigUInt64LE(0) <= BigInt(slot), 'Clock above context'); return data.readBigInt64LE(32);
}

class FinalizedContextAdvanced extends Error {
  constructor(readonly slot:number,readonly pending:readonly PublicKey[]=[]){super('Seeker auction finalized context advanced');}
}
/** K-night-08: a pool node below minContextSlot answers JSON-RPC -32016 and
 * admits nothing, so the same call is asked again after a short bounded wait.
 * Every other error, including the last -32016, still fails closed. */
function nodeBehind(error:unknown):boolean {
  const e=error as {code?:unknown;message?:unknown}|null;
  return !!e&&(e.code===-32016||(typeof e.message==='string'&&e.message.includes('Minimum context slot has not been reached')));
}
export async function untilSeekerContextReached<T>(signal:AbortSignal,call:()=>Promise<T>):Promise<T> {
  for(let retry=0;;retry++){
    signal.throwIfAborted();
    try{return await call();}catch(error){if(!nodeBehind(error)||retry>=SEEKER_AUCTION_NODE_BEHIND_RETRY_MAX)throw error;}
    await delay(SEEKER_AUCTION_NODE_BEHIND_WAIT_MS,undefined,{signal});
  }
}
function copyRow(row:SeekerRawAccount|null):SeekerRawAccount|null {
  return row===null?null:{address:new PublicKey(row.address.toBytes()),owner:new PublicKey(row.owner.toBytes()),executable:row.executable,data:Buffer.from(row.data)};
}
/** Byte identity of everything the reader decodes. Lamports/rentEpoch are not evidence. */
function sameRow(a:SeekerRawAccount|null|undefined,b:SeekerRawAccount|null|undefined):boolean {
  if(a===null||b===null)return a===b;
  return !!a&&!!b&&a.owner.equals(b.owner)&&a.executable===b.executable&&Buffer.from(a.data).equals(Buffer.from(b.data));
}
interface SeekerAuctionEvidence {
  readonly rpc:SeekerAuctionReadRpc;readonly slot:()=>number|undefined;
  readonly read:SeekerAuctionEvidenceBank['read'];readonly assertContext:SeekerAuctionEvidenceBank['assertContext'];
  readonly revalidate:(moved:FinalizedContextAdvanced,spend:()=>void)=>Promise<boolean>;
}
/** K-night-08: every admitted account, all known at exactly one finalized slot.
 * A later response never joins it. Instead every admitted address, plus the batch
 * that moved, is read again at the later floor; the bank adopts that slot only
 * when every answer shares it and no account (Clock aside) changed. A change
 * empties the bank and restarts it at the new floor. */
async function openSeekerAuctionEvidence(source:SeekerAuctionReadSource,signal:AbortSignal):Promise<SeekerAuctionEvidence> {
  const rpc=source.connect(signal);need(await rpc.getGenesisHash()===source.trust.genesisHash,'chain genesis');signal.throwIfAborted();
  let floor=source.trust.deploymentSlot,observedSlot:number|undefined,rows=new Map<string,SeekerRawAccount|null>();
  async function fetchAt(addresses:readonly PublicKey[],minContextSlot:number):Promise<{slot:number;rows:(SeekerRawAccount|null)[]}> {
    const response=await untilSeekerContextReached(signal,()=>rpc.getMultipleAccountsInfoAndContext([...addresses],{commitment:'finalized',minContextSlot}));
    signal.throwIfAborted();const slot=safeSlot(response.context.slot);need(slot>=minContextSlot,'regressing finalized context');
    need(Array.isArray(response.value)&&response.value.length===addresses.length,'incomplete account vector');
    return {slot,rows:addresses.map((key,index)=>{
      const row=response.value[index];if(row===null)return null;
      need(row&&row.data instanceof Uint8Array&&(row.executable===true||row.executable===false),'malformed account response');
      return {address:new PublicKey(key.toBytes()),owner:new PublicKey(row.owner.toBytes()),executable:row.executable,data:Buffer.from(row.data)};
    })};
  }
  async function read(addresses:readonly PublicKey[]):Promise<(SeekerRawAccount|null)[]> {
    need(addresses.length>0&&addresses.length<=RPC_BATCH_MAX,'RPC batch bound');signal.throwIfAborted();
    const keys=addresses.map(key=>key.toBase58());
    if(observedSlot!==undefined&&keys.every(key=>rows.has(key)))return keys.map(key=>copyRow(rows.get(key)!));
    const answer=await fetchAt(addresses,observedSlot??floor);
    observedSlot??=answer.slot;need(answer.slot>=observedSlot,'regressing finalized context');
    if(answer.slot>observedSlot)throw new FinalizedContextAdvanced(answer.slot,addresses);
    keys.forEach((key,index)=>{
      need(!rows.has(key)||sameRow(rows.get(key),answer.rows[index]),'one finalized slot with two account states');
      rows.set(key,copyRow(answer.rows[index]!));
    });
    return answer.rows;
  }
  function assertContext(value:number):void {
    const slot=safeSlot(value);need(observedSlot!==undefined&&slot>=observedSlot,'regressing finalized context');
    if(slot>observedSlot)throw new FinalizedContextAdvanced(slot);
  }
  async function revalidate(moved:FinalizedContextAdvanced,spend:()=>void):Promise<boolean> {
    const keys=[...new Set([...rows.keys(),...moved.pending.map(key=>key.toBase58())])],batches:PublicKey[][]=[];
    need(observedSlot!==undefined&&moved.slot>observedSlot&&keys.length>0,'bank movement without evidence');
    for(let at=0;at<keys.length;at+=RPC_BATCH_MAX)batches.push(keys.slice(at,at+RPC_BATCH_MAX).map(key=>new PublicKey(key)));
    for(let target=moved.slot;;){
      // Concurrent batches are asked together so that one pool snapshot can answer all of them.
      const answers=await Promise.all(batches.map(batch=>fetchAt(batch,target)));signal.throwIfAborted();
      const slot=Math.max(...answers.map(answer=>answer.slot));
      if(answers.some(answer=>answer.slot!==slot)){spend();target=slot;continue;}
      const fresh=new Map(keys.map((key,index)=>[key,answers[Math.floor(index/RPC_BATCH_MAX)]!.rows[index%RPC_BATCH_MAX]!]));
      // The Clock always differs; the restarted callback re-derives time and still refuses a Clock above context.
      if(![...rows].every(([key,row])=>key===CLOCK_KEY||sameRow(row,fresh.get(key)))){rows=new Map();observedSlot=undefined;floor=slot;return false;}
      rows=fresh;observedSlot=slot;return true;
    }
  }
  return Object.freeze({rpc,slot:()=>observedSlot,read,assertContext,revalidate});
}
/** The optional round is bounded refund history. A later bank re-validates every
 * admitted account at one shared deadline and an increased floor, and restarts
 * when anything changed; data/transport faults never become retries or absent
 * accounts. No mixed-bank result is returned. */
export function readSeekerAuctionRound(source:SeekerAuctionReadSource,walletText:string,requestedRound?:bigint,
  callerSignal?:AbortSignal):Promise<SeekerAuctionReadResult> {
  return readRound(source,walletText,requestedRound,callerSignal,false);
}
/** Beacon4dbfed12: issuer/crank-only capability. No route accepts or forwards
 * this selector. Every nonzero private round also proves its predecessor. */
export function readSeekerAuctionPrivateRound(source:SeekerAuctionReadSource,walletText:string,round:bigint,
  callerSignal?:AbortSignal):Promise<SeekerAuctionReadResult> {
  return readRound(source,walletText,round,callerSignal,true);
}
export interface SeekerAuctionEvidenceBank {
  readonly trust:SeekerAuctionReadTrust;readonly program:PublicKey;readonly wallet:PublicKey;
  readonly config:SeekerLiveAuctionConfig;readonly authority:SeekerAuthorityFacts;
  readonly nowSec:bigint;readonly biddingRound:bigint;readonly slot:number;readonly signal:AbortSignal;readonly rpc:SeekerAuctionReadRpc;
  readonly read:(addresses:readonly PublicKey[])=>Promise<(SeekerRawAccount|null)[]>;
  readonly assertContext:(slot:number)=>void;
}
/** Internal evidence capability for round and wallet-refund readers. A callback
 * must not sign or relay: it is re-run after a forward bank movement, from the
 * re-validated evidence (served without RPC) at the adopted slot. */
export async function withSeekerAuctionEvidenceBank<T>(source:SeekerAuctionReadSource,walletText:string,
  callerSignal:AbortSignal|undefined,operation:(bank:SeekerAuctionEvidenceBank)=>Promise<T>):Promise<T> {
  const signal=callerSignal?AbortSignal.any([callerSignal,AbortSignal.timeout(READ_DEADLINE_MS)]):AbortSignal.timeout(READ_DEADLINE_MS);
  signal.throwIfAborted();const fixed={trust:snapshotTrust(source.trust),connect:source.connect},wallet=address(walletText);
  need(PublicKey.isOnCurve(wallet.toBytes()),'wallet signer');
  const evidence=await openSeekerAuctionEvidence(fixed,signal);let restarts=0,advances=0;
  const spend=()=>need(++advances<=SEEKER_AUCTION_BANK_ADVANCE_MAX,'finalized bank keeps moving');
  for(;;){
    signal.throwIfAborted();let moved:FinalizedContextAdvanced;
    try{return await operation(await openSeekerAuctionEvidenceBank(fixed.trust,wallet,evidence,signal));}
    catch(error){if(!(error instanceof FinalizedContextAdvanced))throw error;moved=error;}
    spend();if(!(await evidence.revalidate(moved,spend)))need(++restarts<R.snapshotReadAttempts,'finalized bank keeps moving');
  }
}
async function openSeekerAuctionEvidenceBank(trust:SeekerAuctionReadTrust,wallet:PublicKey,evidence:SeekerAuctionEvidence,
  signal:AbortSignal):Promise<SeekerAuctionEvidenceBank> {
  signal.throwIfAborted(); const program = new PublicKey(trust.programId);
  const configAddress = seekerAuctionConfigPda(program), authorityAddress = seekerAuthorityPda(program), registryAddress = seekerRegistryPda(program);
  const programDataAddress = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0], mint = new PublicKey(trust.mint);
  const core = await evidence.read([program, programDataAddress, authorityAddress, configAddress, registryAddress, mint, SYSVAR_CLOCK_PUBKEY]);
  const slot = evidence.slot()!;
  verifyDeployment(required(core[0]), required(core[1]), trust, slot);
  const authority = decodeSeekerAuthority(trust.programId, trust.genesisHash, required(core[2]));
  const config = decodeSeekerAuctionConfig(program, required(core[3]));
  need(config.mint === trust.mint && config.prizeOwner === trust.prizeOwner && config.decimals === trust.decimals, 'config registry/deployment pins');
  verifyRegistry(required(core[4]), config); verifyMint(required(core[5]), config);
  const nowSec=actualClock(required(core[6]),slot),biddingRound=seekerBiddingRoundAt(config,nowSec);
  return Object.freeze({trust,program,wallet,config,authority,nowSec,biddingRound,slot,signal,rpc:evidence.rpc,
    read:evidence.read,assertContext:evidence.assertContext});
}
async function readRound(source:SeekerAuctionReadSource,walletText:string,requestedRound:bigint|undefined,
  callerSignal:AbortSignal|undefined,allowSuccessor:boolean):Promise<SeekerAuctionReadResult> {
 return withSeekerAuctionEvidenceBank(source,walletText,callerSignal,async bank=>{
  const {trust,program,wallet,config,authority,nowSec,biddingRound,slot,signal,read}=bank;
  const configAddress=new PublicKey(config.address),mint=new PublicKey(config.mint),round=requestedRound??biddingRound;
  need(typeof round === 'bigint' && round >= 0n && round <= U64_MAX && round <= biddingRound + (allowSuccessor ? 1n : 0n)
    && biddingRound - round <= BigInt(R.readRoundsBack), 'round outside read window');
  const operatingStart = signed(config.firstOperatingStart + round * config.termSec), auctionStart = signed(operatingStart - config.auctionSec),
    operatingEnd = signed(operatingStart + config.termSec);
  const termAddress = seekerTermPda(program, configAddress, round), ataAddress = keepAta(wallet, mint);
  const predecessorAddress = allowSuccessor && round > 0n ? seekerTermPda(program, configAddress, round - 1n) : null;
  const selected = await read([termAddress, ataAddress, ...(predecessorAddress ? [predecessorAddress] : [])]), termRaw = selected[0]!, ataRaw = selected[1]!;
  if (predecessorAddress) {
    const previous = decodeSeekerLiveTerm(config, round - 1n, required(selected[2]));
    if (previous.completedAt !== null) need(previous.completedAt <= nowSec && previous.completedSlot !== null
      && previous.completedSlot > BigInt(trust.deploymentSlot) && previous.completedSlot <= BigInt(slot), 'predecessor completion outside observed deployment');
  }
  const term = termRaw === null ? null : decodeSeekerLiveTerm(config, round, termRaw);
  if (term && term.completedAt !== null) need(term.completedAt <= nowSec && term.completedSlot !== null
    && term.completedSlot > BigInt(trust.deploymentSlot) && term.completedSlot <= BigInt(slot), 'term completion outside observed deployment');
  const auctionAddresses = Array.from({ length: P.totalSpots }, (_, spot) => seekerAuctionPda(program, configAddress, spot, round));
  const bidAddresses = auctionAddresses.map(auction => seekerBidPda(program, auction, wallet));
  const auctionRows = await read(auctionAddresses), bidRows = await read(bidAddresses);
  const auctions: (SeekerLiveAuction | null)[] = [], bids: (SeekerLiveBid | null)[] = [];
  for (let spot = 0; spot < P.totalSpots; spot++) {
    const auctionRaw = auctionRows[spot]!, bidRaw = bidRows[spot]!;
    const opened = term !== null && (term.opened[spot >> 3]! & (1 << (spot % 8))) !== 0;
    need(opened === (auctionRaw !== null), 'auction existence disagrees with term');
    const auction = auctionRaw === null ? null : decodeSeekerLiveAuction(config, term!, spot, auctionRaw);
    need(auction !== null || bidRaw === null, 'Bid without auction');
    const bid = bidRaw === null ? null : decodeSeekerLiveBid(program, auctionAddresses[spot]!, wallet, bidRaw);
    if (auction?.settled) need(auction.settledAt !== null && auction.settledAt <= nowSec && auction.settledSlot !== null
      && auction.settledSlot > BigInt(trust.deploymentSlot) && auction.settledSlot <= BigInt(slot), 'auction settlement outside observed deployment');
    if (auction?.highBidder === walletText) {
      need(bid !== null && !bid.refunded && bid.amount === (auction.settled ? 0n : auction.highBid), 'leader Bid backing');
    } else if (auction && bid && bid.amount > 0n) {
      need(bid.amount < auction.highBid && auction.outstandingEscrow >= bid.amount + (auction.settled ? 0n : auction.highBid), 'loser Bid backing');
    }
    auctions.push(auction); bids.push(bid);
  }
  const walletAta = readWalletAta(ataRaw, ataAddress, wallet, config);
  const view = SeekerAuctionSourcedRoundViewSchema.parse({ version: 1, source: 'chain', chainUnixTime: nowSec.toString(), walletSkrRaw: walletAta?.amount.toString() ?? null, wallet: walletText, observedSlot: String(slot), round: round.toString(),
    biddingRound: biddingRound.toString(), admissionPaused: authority.admissionPaused,
    config: { programId: config.programId, address: config.address, mint: config.mint, prizeOwner: config.prizeOwner, prizeAta: config.prizeAta,
      decimals: config.decimals, openingBidRaw: config.openingBid.toString(), firstOperatingStart: config.firstOperatingStart.toString(),
      termSec: config.termSec.toString(), auctionSec: config.auctionSec.toString(), graceSec: config.graceSec.toString() },
    auctionStart: auctionStart.toString(), auctionEnd: operatingStart.toString(), operatingStart: operatingStart.toString(), operatingEnd: operatingEnd.toString(),
    openedCount: term?.openedCount ?? 0, completedCount: term?.completedCount ?? 0, winnerCount: term?.winnerCount ?? 0,
    completedAt: term?.completedAt?.toString() ?? null,
    spots: canonicalSeekerRegistry().map(entry => {
      const auction = auctions[entry.spotId]!, bid = bids[entry.spotId]!;
      return { spot: entry.spotId, class: entry.class === 1 ? 'king' : 'regular', realmMask: entry.realmMask, opened: auction !== null,
        highBidRaw: auction?.highBid.toString() ?? '0', highBidder: auction?.highBidder ?? null, settled: auction?.settled ?? false,
        yourBidRaw: bid?.amount.toString() ?? '0', refundable: bid !== null && bid.amount > 0n && !bid.refunded && auction?.highBidder !== walletText };
    }) });
  signal.throwIfAborted(); return Object.freeze({ view, config, term, auctions: Object.freeze(auctions), bids: Object.freeze(bids), walletAta, nowSec, slot, authority });
 });
}

export interface SeekerAuctionWithdrawalTarget {
 readonly config:SeekerLiveAuctionConfig;readonly term:SeekerLiveTerm;readonly auction:SeekerLiveAuction;
 readonly bid:SeekerLiveBid|null;readonly walletAta:SeekerAuctionReadResult['walletAta'];readonly nowSec:bigint;readonly slot:number;
}
/** One wallet-owned withdrawal target, never a general historical HTTP view.
 * Refunds have no age or pause limit. Reads remain fixed-size and finalized. */
export function readSeekerAuctionWithdrawalTarget(source:SeekerAuctionReadSource,walletText:string,round:bigint,spot:number,
 callerSignal?:AbortSignal):Promise<SeekerAuctionWithdrawalTarget> {
 return withSeekerAuctionEvidenceBank(source,walletText,callerSignal,async bank=>{
  const {program,wallet,config,trust,nowSec,biddingRound,slot,read,signal}=bank;
  need(typeof round==='bigint'&&round>=0n&&round<=U64_MAX&&round<=biddingRound,'withdrawal round');
  need(Number.isInteger(spot)&&spot>=0&&spot<P.totalSpots,'withdrawal spot');
  const configAddress=new PublicKey(config.address),termAddress=seekerTermPda(program,configAddress,round),auctionAddress=seekerAuctionPda(program,configAddress,spot,round);
  const bidAddress=seekerBidPda(program,auctionAddress,wallet),ataAddress=keepAta(wallet,new PublicKey(config.mint));
  const rows=await read([termAddress,auctionAddress,bidAddress,ataAddress]);
  const term=decodeSeekerLiveTerm(config,round,required(rows[0]));
  need((term.opened[spot>>3]!&(1<<(spot%8)))!==0,'withdrawal auction not opened');
  const auction=decodeSeekerLiveAuction(config,term,spot,required(rows[1]));
  const bid=rows[2]===null?null:decodeSeekerLiveBid(program,auctionAddress,wallet,required(rows[2]));
  if(term.completedAt!==null)need(term.completedAt<=nowSec&&term.completedSlot!==null&&term.completedSlot>BigInt(trust.deploymentSlot)&&term.completedSlot<=BigInt(slot),'term completion outside observed deployment');
  if(auction.settled)need(auction.settledAt!==null&&auction.settledAt<=nowSec&&auction.settledSlot!==null&&auction.settledSlot>BigInt(trust.deploymentSlot)&&auction.settledSlot<=BigInt(slot),'auction settlement outside observed deployment');
  if(auction.highBidder===walletText)need(bid!==null&&!bid.refunded&&bid.amount===(auction.settled?0n:auction.highBid),'leader Bid backing');
  else if(bid&&bid.amount>0n)need(bid.amount<auction.highBid&&auction.outstandingEscrow>=bid.amount+(auction.settled?0n:auction.highBid),'loser Bid backing');
  const walletAta=readWalletAta(rows[3]!,ataAddress,wallet,config);signal.throwIfAborted();
  return Object.freeze({config,term,auction,bid,walletAta,nowSec,slot});
 });
}
