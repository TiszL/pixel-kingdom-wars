/** Finalized observations of an original Charter mint. The private loader must
 * validate and preserve the complete B6h consent; these are its on-chain pins,
 * not a substitute consent schema. Admission commitment is an opaque saved
 * policy assertion, never independently verified SHARDS funding here. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { charterAssetPda, charterClanIdBytes, charterConfigPda, charterCreationPda, charterExecutorPda,
  charterFreezePda, charterMintPda, charterPda, hashCharterMetadata } from './charterProtocol';

export interface CharterCreationSavedRecord {
  readonly creationIntentId: string;
  readonly clanId: string;
  readonly payer: string;
  readonly metadata: { readonly name: string; readonly uri: string; readonly hash: string };
  readonly chain: {
    readonly genesisHash: string; readonly economyProgram: string; readonly craftProgram: string;
    readonly config: string; readonly craftControl: string; readonly collection: string;
    readonly collectionAuthority: string; readonly charter: string; readonly asset: string;
    readonly assetBinding: string; readonly freezeAuthority: string; readonly executor: string;
    readonly creationReceipt: string;
  };
  readonly admissionCommitment: string;
  readonly issuedPermitIds: readonly string[];
}
export interface CharterCreationProgramTrust {
  readonly programId: string;
  readonly reviewedDeploymentSlot: number;
  readonly reviewedProgramDataSha256: string;
  readonly upgradeAuthority: string | null;
}
export interface CharterCreationEvidenceTrust {
  readonly expectedGenesisHash: string;
  readonly economy: CharterCreationProgramTrust;
  readonly craft: CharterCreationProgramTrust;
  readonly core: CharterCreationProgramTrust;
  readonly stateProvenance: 'fresh-reviewed-deployment';
}
export interface CharterCreationRawAccount {
  readonly address: PublicKey; readonly owner: PublicKey; readonly executable: boolean; readonly data: Uint8Array;
}
export interface CharterCreationEvidenceRpc {
  getGenesisHash(): Promise<string>;
  getSlot(commitment: 'finalized'): Promise<number>;
  getMultipleAccountsInfoAndContext(addresses: PublicKey[], options: { commitment: 'finalized'; minContextSlot: number }):
    Promise<{ context: { slot: number }; value: (CharterCreationRawAccount | null)[] }>;
}
export type CharterCreationEvidenceErrorCode = 'INPUT' | 'RESERVATION' | 'IDENTITY' | 'DEPLOYMENT' | 'ACCOUNTS' | 'UNAVAILABLE' | 'DEADLINE' | 'BUSY';
export class CharterCreationEvidenceError extends Error {
  readonly reservationReleaseAuthorized = false;
  constructor(readonly code: CharterCreationEvidenceErrorCode) { super(`Charter creation evidence refused: ${code}`); this.name = 'CharterCreationEvidenceError'; }
}
export interface CharterCreationEvidence {
  readonly version: 1; readonly creationIntentId: string; readonly clanId: string; readonly payer: string;
  readonly charter: string; readonly asset: string; readonly creationReceipt: string;
  readonly metadataHash: string; readonly admissionCommitment: string; readonly permitId: string;
  readonly slot: number; readonly unixTimestamp: bigint; readonly createdAt: bigint;
  readonly source: Readonly<{ trust: 'trusted-finalized-rpc-reviewed-program'; stateProvenance: 'fresh-reviewed-deployment';
    genesisHash: string; programs: readonly Readonly<CharterCreationProgramTrust>[];
    accounts: readonly Readonly<{ address: string; owner: string; executable: boolean; dataSha256: string }>[] }>;
  readonly finalizedMintObserved: true; readonly transactionProofVerified: false;
  readonly paymentAuthorized: false; readonly activationAuthorized: false; readonly reservationReleaseAuthorized: false;
}

const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const SYSVAR_OWNER = new PublicKey('Sysvar1111111111111111111111111111111111111');
// Operational bounds, not game tuning. Exceeding a bound always holds recovery.
const MAX_PROGRAM_BYTES = 8 * 1024 * 1024, MAX_CORE_BYTES = 4096, MAX_PERMITS = 256;
const DEADLINE_MS = 60_000, MAX_PENDING = 8;
type Code = CharterCreationEvidenceErrorCode;
function need(value: unknown, code: Code): asserts value { if (!value) throw new CharterCreationEvidenceError(code); }
const safeSlot = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function record(value: unknown, required: string, optional = '', code: Code = 'INPUT'): Record<string, unknown> {
  need(value && typeof value === 'object' && !Array.isArray(value), code);
  const proto = Object.getPrototypeOf(value); need(proto === Object.prototype || proto === null, code);
  const wanted = required.split(' ').filter(Boolean), allowed = [...wanted, ...optional.split(' ').filter(Boolean)];
  const keys = Reflect.ownKeys(value); need(keys.length <= allowed.length && keys.every(k => typeof k === 'string' && allowed.includes(k)), code);
  const copy: Record<string, unknown> = {};
  for (const key of allowed) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property) { need(!wanted.includes(key), code); continue; }
    need(property.enumerable && 'value' in property, code); copy[key] = property.value;
  }
  return copy;
}
function text(value: unknown, maximum: number, code: Code): string {
  need(typeof value === 'string' && value.length > 0 && value.length <= maximum, code); return value;
}
function address(value: unknown, code: Code = 'INPUT'): string {
  const encoded = text(value, 44, code);
  try { const key = new PublicKey(encoded); need(!key.equals(PublicKey.default) && key.toBase58() === encoded, code); return encoded; }
  catch { throw new CharterCreationEvidenceError(code); }
}
function uuid(value: unknown, code: Code): string {
  const encoded = text(value, 36, code);
  try { charterClanIdBytes(encoded); return encoded; } catch { throw new CharterCreationEvidenceError(code); }
}
function hex(value: unknown, bytes: number, code: Code, nonzero = false): string {
  const encoded = text(value, bytes * 2, code);
  need(encoded.length === bytes * 2 && /^[0-9a-f]+$/.test(encoded) && (!nonzero || !/^0+$/.test(encoded)), code); return encoded;
}
function ownArray(value: unknown, maximum: number, code: Code): unknown[] {
  need(Array.isArray(value) && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1, code);
  return Array.from({ length: value.length }, (_, i) => {
    const property = Object.getOwnPropertyDescriptor(value, String(i));
    need(property && property.enumerable && 'value' in property, code); return property.value;
  });
}
function copyKey(value: unknown, code: Code): PublicKey {
  // RPC rows are application adapter output. Detach ordinary SDK keys before
  // another await; arbitrary account-address strings are not accepted as rows.
  need(value instanceof PublicKey, code); return new PublicKey(value.toBytes());
}
function derive(program: string, seed: string, ...tails: Buffer[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), ...tails], new PublicKey(program));
}
function copyTrust(value: unknown): CharterCreationEvidenceTrust {
  const t = record(value, 'expectedGenesisHash economy craft core stateProvenance');
  need(t.stateProvenance === 'fresh-reviewed-deployment', 'INPUT');
  const program = (input: unknown): CharterCreationProgramTrust => {
    const p = record(input, 'programId reviewedDeploymentSlot reviewedProgramDataSha256 upgradeAuthority');
    need(safeSlot(p.reviewedDeploymentSlot), 'INPUT');
    return Object.freeze({ programId: address(p.programId), reviewedDeploymentSlot: p.reviewedDeploymentSlot,
      reviewedProgramDataSha256: hex(p.reviewedProgramDataSha256, 32, 'INPUT'),
      upgradeAuthority: p.upgradeAuthority === null ? null : address(p.upgradeAuthority) });
  };
  const economy = program(t.economy), craft = program(t.craft), core = program(t.core);
  need(core.programId === CORE.toBase58() && new Set([economy.programId, craft.programId, core.programId]).size === 3, 'INPUT');
  return Object.freeze({ expectedGenesisHash: address(t.expectedGenesisHash), economy, craft, core, stateProvenance: t.stateProvenance });
}
const CHAIN_FIELDS = 'genesisHash economyProgram craftProgram config craftControl collection collectionAuthority charter asset assetBinding freezeAuthority executor creationReceipt';
function copyOriginal(value: unknown, requested: string, trust: CharterCreationEvidenceTrust): Omit<CharterCreationSavedRecord, 'issuedPermitIds'> {
  const r = record(value, 'creationIntentId clanId payer metadata chain admissionCommitment', '', 'RESERVATION');
  const creationIntentId = uuid(r.creationIntentId, 'RESERVATION'), clanId = uuid(r.clanId, 'RESERVATION'), payer = address(r.payer, 'RESERVATION');
  need(creationIntentId === requested, 'RESERVATION');
  const m = record(r.metadata, 'name uri hash', '', 'RESERVATION');
  const metadata = Object.freeze({ name: text(m.name, 64, 'RESERVATION'), uri: text(m.uri, 512, 'RESERVATION'), hash: hex(m.hash, 32, 'RESERVATION', true) });
  try { need(hashCharterMetadata({ name: metadata.name, uri: metadata.uri }).toString('hex') === metadata.hash, 'RESERVATION'); }
  catch { throw new CharterCreationEvidenceError('RESERVATION'); }
  const c = record(r.chain, CHAIN_FIELDS, '', 'RESERVATION');
  const chain = Object.freeze(Object.fromEntries(CHAIN_FIELDS.split(' ').map(k => [k, address(c[k], 'RESERVATION')]))) as CharterCreationSavedRecord['chain'];
  need(chain.genesisHash === trust.expectedGenesisHash && chain.economyProgram === trust.economy.programId && chain.craftProgram === trust.craft.programId, 'RESERVATION');
  const economy = new PublicKey(chain.economyProgram), craft = new PublicKey(chain.craftProgram), asset = charterMintPda(craft, clanId);
  const expected = { config: charterConfigPda(economy), craftControl: derive(chain.craftProgram, 'charter_control')[0],
    collection: derive(chain.craftProgram, 'charter_collection')[0], collectionAuthority: derive(chain.craftProgram, 'charter_collection_authority')[0],
    charter: charterPda(economy, clanId), asset, assetBinding: charterAssetPda(economy, asset), freezeAuthority: charterFreezePda(craft, clanId),
    executor: charterExecutorPda(economy, clanId), creationReceipt: charterCreationPda(economy, creationIntentId) };
  for (const field of Object.keys(expected) as (keyof typeof expected)[]) need(chain[field] === expected[field].toBase58(), 'RESERVATION');
  return Object.freeze({ creationIntentId, clanId, payer, metadata, chain, admissionCommitment: hex(r.admissionCommitment, 32, 'RESERVATION', true) });
}
function copySaved(value: unknown, requested: string, trust: CharterCreationEvidenceTrust): CharterCreationSavedRecord {
  const r = record(value, 'creationIntentId clanId payer metadata chain admissionCommitment issuedPermitIds', '', 'RESERVATION');
  const { issuedPermitIds: suppliedIds, ...pins } = r;
  const original = copyOriginal(pins, requested, trust);
  const issuedPermitIds = ownArray(suppliedIds, MAX_PERMITS, 'RESERVATION').map(p => hex(p, 16, 'RESERVATION'));
  need(issuedPermitIds.length > 0 && new Set(issuedPermitIds).size === issuedPermitIds.length, 'RESERVATION');
  return Object.freeze({ ...original, issuedPermitIds: Object.freeze(issuedPermitIds) });
}

const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const u64 = (value: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b; };
const stringBytes = (value: string) => Buffer.concat([u32(Buffer.byteLength(value)), Buffer.from(value)]);
const discriminator = (name: string) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
function anchorBytes(name: string, fields: Buffer[]): Buffer { return Buffer.concat([discriminator(name), Buffer.of(1), ...fields]); }
type OwnedAccount = { address: PublicKey; owner: PublicKey; executable: boolean; data: Buffer };
function assertAccount(row: OwnedAccount, owner: string, expected: Buffer): void {
  need(row.owner.toBase58() === owner && !row.executable && row.data.equals(expected), 'ACCOUNTS');
}
function attestProgram(program: OwnedAccount, data: OwnedAccount, trust: CharterCreationProgramTrust): void {
  need(program.executable && program.owner.equals(LOADER) && !data.executable && data.owner.equals(LOADER)
    && program.data.length === 36 && program.data.readUInt32LE(0) === 2 && data.data.length >= 45
    && data.data.readUInt32LE(0) === 3 && data.data.readBigUInt64LE(4) === BigInt(trust.reviewedDeploymentSlot), 'DEPLOYMENT');
  need(program.data.subarray(4).equals(data.address.toBuffer()) && digest(data.data) === trust.reviewedProgramDataSha256, 'DEPLOYMENT');
  const option = data.data[12]; need(option === 0 || option === 1, 'DEPLOYMENT');
  const authority = option === 0 ? null : new PublicKey(data.data.subarray(13, 45)).toBase58();
  need(authority === trust.upgradeAuthority, 'DEPLOYMENT');
}
function verifyCore(asset: OwnedAccount, collection: OwnedAccount, saved: CharterCreationSavedRecord): void {
  const key = (v: string) => new PublicKey(v).toBuffer(), c = saved.chain;
  // B6g CreateV1 postcondition is exact fresh seq=None, not a hooked decoder's
  // normalized plugin list. Every header, offset, tag and trailing byte binds.
  const base = Buffer.concat([Buffer.of(1), key(saved.payer), Buffer.of(2), key(c.collection), stringBytes(saved.metadata.name), stringBytes(saved.metadata.uri), Buffer.of(0)]);
  const pluginOffset = base.length + 9, registryOffset = pluginOffset + 2;
  const expected = Buffer.concat([base, Buffer.of(3), u64(BigInt(registryOffset)), Buffer.of(5, 1, 4), u32(1), Buffer.of(5, 3),
    key(c.freezeAuthority), u64(BigInt(pluginOffset)), u32(0)]);
  assertAccount(asset, CORE.toBase58(), expected);
  verifyCollection(collection, saved, true);
}
function verifyCollection(collection: OwnedAccount, saved: Omit<CharterCreationSavedRecord, 'issuedPermitIds'>, mintedRequired: boolean): void {
  const key = (v: string) => new PublicKey(v).toBuffer(), c = saved.chain;
  need(collection.owner.equals(CORE) && !collection.executable, 'ACCOUNTS');
  const bytes = collection.data; let at = 0;
  const take = (length: number) => { need(Number.isSafeInteger(length) && length >= 0 && at + length <= bytes.length, 'ACCOUNTS'); const part = bytes.subarray(at, at + length); at += length; return part; };
  need(take(1)[0] === 5 && take(32).equals(key(c.collectionAuthority)), 'ACCOUNTS');
  for (let i = 0; i < 2; i++) {
    const length = take(4).readUInt32LE(0), data = take(length);
    need(Buffer.from(data.toString('utf8'), 'utf8').equals(data), 'ACCOUNTS');
  }
  const minted = take(4).readUInt32LE(0), size = take(4).readUInt32LE(0);
  // Other clans may mint after this one. Current counters need not equal one.
  need((!mintedRequired || size > 0) && size <= minted && at === bytes.length, 'ACCOUNTS');
}
function verifyAccounts(rows: OwnedAccount[], saved: CharterCreationSavedRecord, observedSlot: number): { permitId: string; createdAt: bigint; unixTimestamp: bigint } {
  const c = saved.chain, key = (v: string) => new PublicKey(v).toBuffer(), clan = charterClanIdBytes(saved.clanId), intent = charterClanIdBytes(saved.creationIntentId);
  const bump = (program: string, seed: string, ...tail: Buffer[]) => Buffer.of(derive(program, seed, ...tail)[1]);
  const config = rows[6]!, control = rows[7]!, charter = rows[8]!, receipt = rows[9]!, binding = rows[10]!, asset = rows[11]!, collection = rows[12]!, clock = rows[13]!;
  const unixTimestamp = verifyCommon(config, control, clock, saved, observedSlot);
  need(charter.data.length === 280, 'ACCOUNTS');
  const permit = charter.data.subarray(255, 271), permitId = permit.toString('hex'), createdAt = charter.data.readBigInt64LE(271);
  need(saved.issuedPermitIds.includes(permitId) && createdAt > 0n && createdAt <= unixTimestamp, 'ACCOUNTS');
  assertAccount(charter, c.economyProgram, anchorBytes('ClanCharter', [key(c.config), clan, key(c.asset), key(c.collection), key(saved.payer), u32(0), Buffer.of(1, 0), Buffer.alloc(16), intent,
    Buffer.from(saved.metadata.hash, 'hex'), Buffer.from(saved.admissionCommitment, 'hex'), permit, u64(createdAt), bump(c.economyProgram, 'charter', clan)]));
  assertAccount(receipt, c.economyProgram, anchorBytes('CharterCreationReceipt', [intent, clan, key(c.charter), key(c.asset), key(saved.payer), permit, bump(c.economyProgram, 'charter_creation', intent)]));
  assertAccount(binding, c.economyProgram, anchorBytes('CharterAssetBinding', [key(c.asset), clan, key(c.charter), bump(c.economyProgram, 'charter_asset', key(c.asset))]));
  verifyCore(asset, collection, saved); return { permitId, createdAt, unixTimestamp };
}


function verifyCommon(config: OwnedAccount, control: OwnedAccount, clock: OwnedAccount,
  saved: { readonly chain: Pick<CharterCreationSavedRecord['chain'], 'economyProgram' | 'craftProgram' | 'craftControl' | 'collection' | 'collectionAuthority'> }, observedSlot: number): bigint {
  const c = saved.chain, key = (v: string) => new PublicKey(v).toBuffer();
  const bump = (program: string, seed: string) => Buffer.of(derive(program, seed)[1]);
  need(clock.owner.equals(SYSVAR_OWNER) && !clock.executable && clock.data.length === 40 && clock.data.readBigUInt64LE(0) === BigInt(observedSlot), 'ACCOUNTS');
  const unixTimestamp = clock.data.readBigInt64LE(32); need(unixTimestamp > 0n, 'ACCOUNTS');
  assertAccount(config, c.economyProgram, anchorBytes('CharterConfig', [derive(c.economyProgram, 'seeker_authority')[0].toBuffer(), key(c.craftProgram), key(c.craftControl),
    key(c.collection), key(c.collectionAuthority), bump(c.economyProgram, 'charter_config')]));
  need(control.data.length === 141 && control.data.subarray(9, 41).some(byte => byte !== 0) && (control.data[137] === 0 || control.data[137] === 1), 'ACCOUNTS');
  // Bootstrap admin is historical. Current admission pause never erases an
  // already completed mint; neither field is today's signing authority here.
  assertAccount(control, c.craftProgram, anchorBytes('CharterControl', [control.data.subarray(9, 41), key(c.economyProgram), key(c.collection), key(c.collectionAuthority),
    Buffer.of(control.data[137]!), bump(c.craftProgram, 'charter_control'), bump(c.craftProgram, 'charter_collection'), bump(c.craftProgram, 'charter_collection_authority')]));
  return unixTimestamp;
}

function mintEvidence(rows: OwnedAccount[], saved: CharterCreationSavedRecord, observedSlot: number,
  trust: CharterCreationEvidenceTrust): CharterCreationEvidence {
  const c = saved.chain, programs = Object.freeze([trust.economy, trust.craft, trust.core]);
  const { permitId, createdAt, unixTimestamp } = verifyAccounts(rows, saved, observedSlot);
  return Object.freeze({ version: 1 as const, creationIntentId: saved.creationIntentId, clanId: saved.clanId, payer: saved.payer,
        charter: c.charter, asset: c.asset, creationReceipt: c.creationReceipt, metadataHash: saved.metadata.hash,
        admissionCommitment: saved.admissionCommitment, permitId, slot: observedSlot, unixTimestamp, createdAt,
        source: Object.freeze({ trust: 'trusted-finalized-rpc-reviewed-program' as const, stateProvenance: trust.stateProvenance,
          genesisHash: trust.expectedGenesisHash, programs, accounts: Object.freeze(rows.map(row => Object.freeze({ address: row.address.toBase58(),
            owner: row.owner.toBase58(), executable: row.executable, dataSha256: digest(row.data) }))) }),
        finalizedMintObserved: true as const, transactionProofVerified: false as const, paymentAuthorized: false as const,
        activationAuthorized: false as const, reservationReleaseAuthorized: false as const });
}

// Internal only: not exported by the package subpaths. No transport or signing.
export { LOADER, MAX_PROGRAM_BYTES, MAX_CORE_BYTES, MAX_PERMITS, DEADLINE_MS, MAX_PENDING, need, safeSlot, digest, record, ownArray, copyKey, address, uuid, copyTrust, copyOriginal, copySaved, attestProgram, verifyCommon, verifyCollection, verifyCore, mintEvidence };
export type { OwnedAccount };
