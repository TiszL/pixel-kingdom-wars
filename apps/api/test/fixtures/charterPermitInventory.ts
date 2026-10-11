/** Uses actual B6l money and B6i custody; no policy key or issuer is configured. */
import { createHash, randomBytes } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { encodeCharterRegistrationPermit, hashCharterRegistrationPayload } from '@shardkeep/chain/charter-protocol';
import { createCharterCreationPermitInventory, type CharterCreationPermitInventory } from '../../src/game/clanCharterCreationPermitInventory';
import { charterCreationFundingFixture } from './charterCreationFunding';

export const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
export const FIXTURE_EXPIRY = 1_800_000_000n;
export async function charterPermitInventoryFixture(settings: Parameters<typeof charterCreationFundingFixture>[0] = {}) {
  const f = await charterCreationFundingFixture(settings);
  const inventory = () => createCharterCreationPermitInventory(f.db);
  async function fund(actor = f.source) {
    const consent = f.consent(actor), reservation = await f.service().reserve(actor.wallet, consent);
    return { actor, consent, reservation };
  }
  function message(saved: CharterCreationPermitInventory, options: { permitId?: Uint8Array; expiry?: bigint } = {}) {
    const c = saved.reservation.consent, p = (field: keyof typeof c.chain) => new PublicKey(c.chain[field]);
    const payloadHash = hashCharterRegistrationPayload({ config: p('config'), craftProgram: p('craftProgram'), craftControl: p('craftControl'),
      collection: p('collection'), collectionAuthority: p('collectionAuthority'), charter: p('charter'), asset: p('asset'),
      assetBinding: p('assetBinding'), freezeAuthority: p('freezeAuthority'), executor: p('executor'), creationReceipt: p('creationReceipt'),
      clanId: c.clanId, leader: new PublicKey(c.payer), creationIntentId: c.creationIntentId,
      metadataHash: Buffer.from(c.metadata.hash, 'hex'), admissionCommitment: Buffer.from(saved.admission.commitment, 'hex') });
    return encodeCharterRegistrationPermit({ genesisHash: p('genesisHash'), programId: p('economyProgram'), kind: 5,
      permitId: options.permitId ?? randomBytes(16), wallet: new PublicKey(c.payer), expiry: options.expiry ?? FIXTURE_EXPIRY, payloadHash });
  }
  async function snapshot() {
    return { funding: await f.snapshot(), heads: await f.sql`select * from charter_creation_permit_heads order by reservation_id`,
      messages: await f.sql`select * from charter_creation_permit_messages order by reservation_id` };
  }
  return { ...f, inventory, fund, message, inventorySnapshot: snapshot };
}
export function postgresLeaf(error: unknown) {
  let cause = error, leaf: { code: string; message: string } | undefined;
  for (let n = 0; n < 8 && cause && typeof cause === 'object'; n++) {
    if ('code' in cause && typeof cause.code === 'string' && /^[A-Z0-9]{5}$/.test(cause.code)
      && 'message' in cause && typeof cause.message === 'string') leaf = { code: cause.code, message: cause.message };
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  if (!leaf) throw Error('Expected a real PostgreSQL leaf, not echoed query metadata');
  return leaf;
}
