/** Pure, declared creation consent only. No caller-supplied field establishes
 * ownership, an ownership epoch, reserved money, name/membership rights or
 * deployment trust. Those require separate server-owned sources and storage.
 *
 * Clan founding is an untaxed SHARDS spend. Its creation terms are the immutable
 * consent below, not a Seeker earning-term/eligibility requirement. No Seeker
 * reader or observation is needed or inferred here.
 *
 * The epoch reference is deliberately declarative: no epoch provider exists in
 * this block, and updatedAt, vehicle revisions and observation hashes cannot
 * substitute for one. reservationId names an eventual reservation; it proves
 * neither that the reservation exists nor that it is funded or releasable.
 */
import { CLANS } from '@shardkeep/shared';
import { PublicKey } from '@solana/web3.js';
import {
  charterAssetPda, charterClanIdBytes, charterConfigPda, charterCreationPda,
  charterExecutorPda, charterFreezePda, charterMintPda, charterPda, hashCharterMetadata,
} from '@shardkeep/chain/charter-protocol';

export interface CharterCreationConsent {
  readonly version: 1;
  readonly creationIntentId: string;
  readonly clanId: string;
  readonly payer: string;
  readonly funding: {
    readonly baseId: string;
    readonly deedAssetId: string;
    readonly ownershipEpoch: { readonly id: string; readonly evidenceCommitment: string };
  };
  readonly clan: { readonly name: string; readonly tag: string; readonly inviteMode: 'open' | 'invite' };
  readonly price: { readonly source: 'CLANS.createCostShards'; readonly version: 1; readonly shards: string };
  readonly metadata: { readonly name: string; readonly uri: string; readonly hash: string };
  readonly chain: {
    readonly genesisHash: string;
    readonly economyProgram: string;
    readonly craftProgram: string;
    readonly config: string;
    readonly craftControl: string;
    readonly collection: string;
    readonly collectionAuthority: string;
    readonly charter: string;
    readonly asset: string;
    readonly assetBinding: string;
    readonly freezeAuthority: string;
    readonly executor: string;
    readonly creationReceipt: string;
  };
  readonly reservationId: string;
}

type ConsentErrorCode = 'INVALID_CONSENT' | 'CONSENT_CONFLICT';
export class CharterCreationConsentError extends Error {
  constructor(readonly code: ConsentErrorCode) {
    super(`Charter creation consent refused: ${code}`);
    this.name = 'CharterCreationConsentError';
  }
}

function invalid(): never { throw new CharterCreationConsentError('INVALID_CONSENT'); }

/** Copy only own data properties. Neither accessors, inherited fields nor extra
 * non-JSON properties can smuggle authority into the saved descriptor. */
function record(value: unknown, fields: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const names = fields.split(' '), keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) return invalid();
  const copied: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalid();
    copied[name] = descriptor.value;
  }
  return copied;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) return invalid();
  return value;
}

function uuid(value: unknown): string {
  const result = text(value, 36);
  charterClanIdBytes(result);
  return result;
}

function address(value: unknown): string {
  // A 32-byte base58 key has at most 44 characters. Bound before decoding.
  const result = text(value, 44);
  if (/[^1-9A-HJ-NP-Za-km-z]/.test(result)) return invalid();
  const key = new PublicKey(result);
  if (key.equals(PublicKey.default) || key.toBase58() !== result) return invalid();
  return result;
}

function commitment(value: unknown): string {
  const result = text(value, 64);
  if (result.length !== 64 || /[^0-9a-f]/.test(result) || /^0+$/.test(result)) return invalid();
  return result;
}

function shards(value: unknown): string {
  // Representation limit of the existing signed-bigint ledger, not a price.
  const result = text(value, 19);
  if (result[0] === '0' || /[^0-9]/.test(result) || BigInt(result) > (1n << 63n) - 1n) return invalid();
  return result;
}

function copy(value: unknown): CharterCreationConsent {
  const root = record(value, 'version creationIntentId clanId payer funding clan price metadata chain reservationId');
  if (root.version !== 1) return invalid();
  const creationIntentId = uuid(root.creationIntentId), clanId = uuid(root.clanId), payer = address(root.payer);
  const reservationId = uuid(root.reservationId);

  const fundingInput = record(root.funding, 'baseId deedAssetId ownershipEpoch');
  const epochInput = record(fundingInput.ownershipEpoch, 'id evidenceCommitment');
  const ownershipEpoch = Object.freeze({ id: uuid(epochInput.id), evidenceCommitment: commitment(epochInput.evidenceCommitment) });
  const funding = Object.freeze({ baseId: uuid(fundingInput.baseId), deedAssetId: address(fundingInput.deedAssetId), ownershipEpoch });

  const clanInput = record(root.clan, 'name tag inviteMode');
  const name = text(clanInput.name, CLANS.nameMaxLen), tag = text(clanInput.tag, CLANS.tagMaxLen);
  // Same canonical name/tag rules as createClan, without changing saved consent
  // by trimming, uppercasing or silently supplying the default invite mode.
  if (name.length < CLANS.nameMinLen || name.trim() !== name || !/^[A-Za-z0-9 ._-]+$/.test(name)
    || tag.length < CLANS.tagMinLen || tag.trim() !== tag || !/^[A-Z0-9]+$/.test(tag)
    || (clanInput.inviteMode !== 'open' && clanInput.inviteMode !== 'invite')) return invalid();
  const clan = Object.freeze({ name, tag, inviteMode: clanInput.inviteMode });

  const priceInput = record(root.price, 'source version shards');
  if (priceInput.source !== 'CLANS.createCostShards' || priceInput.version !== 1) return invalid();
  const price = Object.freeze({ source: priceInput.source, version: priceInput.version, shards: shards(priceInput.shards) });

  const metadataInput = record(root.metadata, 'name uri hash');
  // These are the B6g technical UTF8 byte limits. Prebound UTF16 length before
  // the shared encoder enforces exact UTF8 and computes its SKCHMET1 hash.
  const metadata = Object.freeze({ name: text(metadataInput.name, 64), uri: text(metadataInput.uri, 512), hash: commitment(metadataInput.hash) });
  if (hashCharterMetadata({ name: metadata.name, uri: metadata.uri }).toString('hex') !== metadata.hash) return invalid();

  const chainInput = record(root.chain, 'genesisHash economyProgram craftProgram config craftControl collection collectionAuthority charter asset assetBinding freezeAuthority executor creationReceipt');
  const chain = Object.freeze({
    genesisHash: address(chainInput.genesisHash), economyProgram: address(chainInput.economyProgram), craftProgram: address(chainInput.craftProgram),
    config: address(chainInput.config), craftControl: address(chainInput.craftControl), collection: address(chainInput.collection),
    collectionAuthority: address(chainInput.collectionAuthority), charter: address(chainInput.charter), asset: address(chainInput.asset),
    assetBinding: address(chainInput.assetBinding), freezeAuthority: address(chainInput.freezeAuthority), executor: address(chainInput.executor),
    creationReceipt: address(chainInput.creationReceipt),
  });
  const economy = new PublicKey(chain.economyProgram), craft = new PublicKey(chain.craftProgram);
  const asset = charterMintPda(craft, clanId);
  const craftPda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], craft)[0].toBase58();
  const expectedPins = {
    config: charterConfigPda(economy).toBase58(), craftControl: craftPda('charter_control'), collection: craftPda('charter_collection'),
    collectionAuthority: craftPda('charter_collection_authority'), charter: charterPda(economy, clanId).toBase58(), asset: asset.toBase58(),
    assetBinding: charterAssetPda(economy, asset).toBase58(), freezeAuthority: charterFreezePda(craft, clanId).toBase58(),
    executor: charterExecutorPda(economy, clanId).toBase58(), creationReceipt: charterCreationPda(economy, creationIntentId).toBase58(),
  };
  for (const field of Object.keys(expectedPins) as Array<keyof typeof expectedPins>) {
    if (chain[field] !== expectedPins[field]) return invalid();
  }
  return Object.freeze({ version: 1, creationIntentId, clanId, payer, funding, clan, price, metadata, chain, reservationId });
}

/** New declared consent must carry today's CLANS.createCostShards amount.
 * Successful consistency validation will not authenticate any supplied fact. */
export function captureCharterCreationConsent(value: unknown): CharterCreationConsent {
  const saved = copyCharterCreationConsent(value);
  if (saved.price.shards !== String(CLANS.createCostShards)) return invalid();
  return saved;
}

/** Detached, recursively frozen historical copy. Never reprice saved consent
 * using today's gameplay constants or consult current ownership/admission. */
export function copyCharterCreationConsent(value: unknown): CharterCreationConsent {
  try { return copy(value); }
  catch (error) {
    if (error instanceof CharterCreationConsentError) throw error;
    return invalid();
  }
}

/** Both originals must be structurally valid and exactly agree in every field.
 * This is recovery comparison only, not current signing or spending authority. */
export function recoverCharterCreationConsent(original: unknown, expected: unknown): CharterCreationConsent {
  const saved = copyCharterCreationConsent(original), replay = copyCharterCreationConsent(expected);
  // Both copies have the same explicit field order and contain only bounded
  // primitive values. Input object insertion order cannot change this comparison.
  if (JSON.stringify(saved) !== JSON.stringify(replay)) throw new CharterCreationConsentError('CONSENT_CONFLICT');
  return saved;
}
