/** Charter identity and registration bytes only. No signer, RPC or ownership authority.
 * Program identities are always explicit; no production craft identity is inferred.
 */
import { PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

/** Canonical RFC UUID (versions1–8, standard variant), excluding nil/max sentinels.
 * Rust receives these exact16 bytes in textual hex order as [u8;16]. This is not
 * a u64, a little-endian integer conversion, a hash, or a normalized UUID alias.
 */
export function charterClanIdBytes(clanId: string): Buffer {
  if (typeof clanId !== 'string' || clanId.length !== 36
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clanId)) {
    throw new TypeError('Expected a nonzero canonical lowercase Charter clan UUID');
  }
  return Buffer.from(clanId.replaceAll('-', ''), 'hex');
}

function keyBytes(value: PublicKey): Buffer {
  // pnpm callers may use another installed web3 copy. Require canonical bytes
  // and text rather than JavaScript class identity, and detach before deriving.
  if (!value || typeof value !== 'object' || typeof value.toBytes !== 'function'
    || typeof value.toBase58 !== 'function') throw new TypeError('Expected a nonzero PublicKey');
  const bytes = value.toBytes();
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new TypeError('Expected32 public-key bytes');
  const copy = Buffer.from(bytes);
  if (copy.every(byte => byte === 0) || new PublicKey(copy).toBase58() !== value.toBase58()) {
    throw new TypeError('Expected a nonzero canonical PublicKey');
  }
  return copy;
}

function pda(program: PublicKey, seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, new PublicKey(keyBytes(program)))[0];
}

export function charterConfigPda(economyProgram: PublicKey): PublicKey {
  return pda(economyProgram, [Buffer.from('charter_config')]);
}

export function charterPda(economyProgram: PublicKey, clanId: string): PublicKey {
  return pda(economyProgram, [Buffer.from('charter'), charterClanIdBytes(clanId)]);
}

export function charterAssetPda(economyProgram: PublicKey, asset: PublicKey): PublicKey {
  return pda(economyProgram, [Buffer.from('charter_asset'), keyBytes(asset)]);
}

/** The freeze authority belongs to the explicitly supplied craft program. */
export function charterFreezePda(craftProgram: PublicKey, clanId: string): PublicKey {
  return pda(craftProgram, [Buffer.from('charter_freeze'), charterClanIdBytes(clanId)]);
}

/** The future craft executor's authorized caller belongs to economy. */
export function charterExecutorPda(economyProgram: PublicKey, clanId: string): PublicKey {
  return pda(economyProgram, [Buffer.from('charter_executor'), charterClanIdBytes(clanId)]);
}

export const CHARTER_REGISTRATION_PAYLOAD_BYTES = 490;
export const CHARTER_REGISTRATION_PERMIT_BYTES = 161;
export interface CharterMetadata { readonly name: string; readonly uri: string }
export interface CharterRegistrationPayload {
  readonly config: PublicKey; readonly craftProgram: PublicKey; readonly craftControl: PublicKey;
  readonly collection: PublicKey; readonly collectionAuthority: PublicKey; readonly charter: PublicKey;
  readonly asset: PublicKey; readonly assetBinding: PublicKey; readonly freezeAuthority: PublicKey;
  readonly executor: PublicKey; readonly creationReceipt: PublicKey; readonly clanId: string;
  readonly leader: PublicKey; readonly creationIntentId: string;
  readonly metadataHash: Uint8Array; readonly admissionCommitment: Uint8Array;
}
export interface CharterRegistrationPermit {
  readonly genesisHash: PublicKey; readonly programId: PublicKey; readonly kind: 5;
  readonly permitId: Uint8Array; readonly wallet: PublicKey; readonly expiry: bigint;
  readonly payloadHash: Uint8Array;
}
export function charterMintPda(craftProgram: PublicKey, clanId: string): PublicKey {
  return pda(craftProgram, [Buffer.from('charter_mint'), charterClanIdBytes(clanId)]);
}
export function charterCreationPda(economyProgram: PublicKey, creationIntentId: string): PublicKey {
  return pda(economyProgram, [Buffer.from('charter_creation'), charterClanIdBytes(creationIntentId)]);
}
function exactKeys(value: object, fields: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== fields.split(' ').sort().join(',')) throw new TypeError('Unexpected Charter wire fields');
}
function copiedBytes(value: Uint8Array, length: number, nonzero = false): Buffer {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new TypeError('Unexpected Charter byte width');
  const result = Buffer.from(value);
  if (nonzero && result.every(byte => byte === 0)) throw new TypeError('Missing Charter commitment');
  return result;
}
function metadataString(value: string, maximum: number): Buffer {
  if (typeof value !== 'string') throw new TypeError('Expected exact Charter UTF8 metadata');
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value || bytes.length === 0 || bytes.length > maximum) throw new TypeError('Unsupported Charter metadata byte length');
  const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}
/** D153.151 technical UTF8 limits, matching the guarded craft bootstrap ABI. */
export function encodeCharterMetadata(value: CharterMetadata): Buffer {
  exactKeys(value, 'name uri');
  return Buffer.concat([Buffer.from('SKCHMET1'), metadataString(value.name, 64), metadataString(value.uri, 512)]);
}
export function hashCharterMetadata(value: CharterMetadata): Buffer { return Buffer.from(keccak_256(encodeCharterMetadata(value))); }
export function encodeCharterRegistrationPayload(value: CharterRegistrationPayload): Buffer {
  exactKeys(value, 'config craftProgram craftControl collection collectionAuthority charter asset assetBinding freezeAuthority executor creationReceipt clanId leader creationIntentId metadataHash admissionCommitment');
  return Buffer.concat([Buffer.from('SKCHREG1'), Buffer.from([1, 0]),
    ...[value.config, value.craftProgram, value.craftControl, value.collection, value.collectionAuthority,
      value.charter, value.asset, value.assetBinding, value.freezeAuthority, value.executor, value.creationReceipt].map(keyBytes),
    charterClanIdBytes(value.clanId), keyBytes(value.leader), charterClanIdBytes(value.creationIntentId),
    copiedBytes(value.metadataHash, 32, true), copiedBytes(value.admissionCommitment, 32, true)]);
}
export function hashCharterRegistrationPayload(value: CharterRegistrationPayload): Buffer {
  return Buffer.from(keccak_256(encodeCharterRegistrationPayload(value)));
}
export function encodeCharterRegistrationPermit(value: CharterRegistrationPermit): Buffer {
  exactKeys(value, 'genesisHash programId kind permitId wallet expiry payloadHash');
  if (value.kind !== 5) throw new TypeError('Expected Charter registration permit kind5');
  if (typeof value.expiry !== 'bigint' || value.expiry < -(1n << 63n) || value.expiry >= 1n << 63n) throw new RangeError('Expected signed int64 Charter expiry');
  const expiry = Buffer.alloc(8); expiry.writeBigInt64LE(value.expiry);
  return Buffer.concat([Buffer.from('SKPERMT2'), keyBytes(value.genesisHash), keyBytes(value.programId), Buffer.from([5]),
    copiedBytes(value.permitId, 16), keyBytes(value.wallet), expiry, copiedBytes(value.payloadHash, 32, true)]);
}
/** Shape only: does not authenticate policy signature, expiry, state or caller rights. */
export function decodeCharterRegistrationPermit(value: Uint8Array): CharterRegistrationPermit {
  const bytes = copiedBytes(value, CHARTER_REGISTRATION_PERMIT_BYTES);
  if (!bytes.subarray(0, 8).equals(Buffer.from('SKPERMT2')) || bytes[72] !== 5) throw new TypeError('Wrong Charter permit domain or kind');
  const result: CharterRegistrationPermit = { genesisHash: new PublicKey(bytes.subarray(8, 40)), programId: new PublicKey(bytes.subarray(40, 72)),
    kind: 5, permitId: Buffer.from(bytes.subarray(73, 89)), wallet: new PublicKey(bytes.subarray(89, 121)),
    expiry: bytes.readBigInt64LE(121), payloadHash: Buffer.from(bytes.subarray(129)) };
  encodeCharterRegistrationPermit(result); // Apply the same canonical key/commitment constraints in both directions.
  return result;
}
