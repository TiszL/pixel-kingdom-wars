/** K272: retained pre-Charter ABI plus independent full-IDL/manual-wire parity.
 * Synthetic unsigned examples only; no RPC, provider, wallet or on-chain authority.
 * Historical snapshot SHA 02f1c5db… is preserved rather than reclassified as scoped.
 * Accepted manifest 26c7f4b7 and review 6ed68df9 supersede address retention with
 * E2/C2. Only identity-address expectations rotate; the retained ABI and bytes do not.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import anchorPkg, { type Idl } from '@coral-xyz/anchor';
import { keccak_256 } from '@noble/hashes/sha3';
import { AddressLookupTableAccount, AddressLookupTableProgram, PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, TransactionMessage, VersionedTransaction,
  type TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import retained from './testFixtures/economyIdlPreCharter.json' with { type: 'json' };
import { buildCharterCreationPacket, type CharterPacketInput } from './charterCreationPreparation';
import { encodeCharterRegistrationPermit, hashCharterRegistrationPayload } from './charterProtocol';
import { buildCharterTransferInstruction, buildCharterLockInstruction } from './charterTransferProtocol';
import { buildCharterRetirementInstruction } from './charterRetirementProtocol';

const { BorshInstructionCoder, BN } = anchorPkg;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const raw = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)));
const economy = new PublicKey('5qyN1Xbe2L16t7MPwwcD5QGmLYAnGF4VjN9BXtazvzkr');
const craft = new PublicKey('4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59');
const core = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const leader = key(11), buyer = key(12), treasury = key(13);
// Deliberately different UUIDs and non-palindromic scalar/byte values expose order/endian mistakes.
const clan = '10234567-89ab-4cde-8f01-23456789abcd';
const operation = 'fedcba98-7654-4321-9abc-0123456789ab';
const fence = 'a1234567-1234-5678-abcd-1234567890ab';
const uuid = (s: string) => Buffer.from(s.replaceAll('-', ''), 'hex');
const permitId = Buffer.from('01030507090b0d0f11131517191b1d1f', 'hex');
const commitment = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const expiry = 1_800_002_003n, revision = 0x01020304;
const permit = { permitId, expiry, ed25519Instruction: 1 };
const idlPermit = { permit_id: [...permitId], expiry: new BN(expiry.toString()), ed25519_instruction: 1 };
// Independent PDA construction: no manual-builder account/seed helper is imported.
const pda = (program: PublicKey, seed: string, ...tails: Uint8Array[]) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), ...tails.map(t => Buffer.from(t))], program)[0];
const asset = pda(craft, 'charter_mint', uuid(clan));
const bindings: Record<string, PublicKey> = {
  leader, buyer, seller: leader, treasury, authority: pda(economy, 'seeker_authority'),
  config: pda(economy, 'charter_config'), charter: pda(economy, 'charter', uuid(clan)),
  asset_binding: pda(economy, 'charter_asset', asset.toBytes()),
  creation_receipt: pda(economy, 'charter_creation', uuid(operation)),
  transfer_config: pda(economy, 'charter_transfer_config'),
  transfer_receipt: pda(economy, 'charter_transfer', uuid(operation)),
  retirement_receipt: pda(economy, 'charter_retirement', uuid(clan)),
  receipt: pda(economy, 'permit', permitId), executor: pda(economy, 'charter_executor', uuid(clan)),
  craft_program: craft, craft_control: pda(craft, 'charter_control'), asset,
  collection: pda(craft, 'charter_collection'), collection_authority: pda(craft, 'charter_collection_authority'),
  freeze_authority: pda(craft, 'charter_freeze', uuid(clan)), mpl_core_program: core,
  instructions: SYSVAR_INSTRUCTIONS_PUBKEY, system_program: SystemProgram.programId, economy_program: economy,
};
function bound(name: string): PublicKey {
  const result = bindings[name]; if (!result) throw new Error(`Missing independent account binding: ${name}`); return result;
}
type AccountNode = { name: string; accounts?: AccountNode[]; signer?: boolean; writable?: boolean; address?: string };
function idlMetas(nodes: AccountNode[]): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  return nodes.flatMap(node => {
    // Anchor groups cpi/profile accounts; parent flags must never replace leaf flags/order.
    if (node.accounts) return idlMetas(node.accounts);
    const pubkey = bound(node.name);
    if (node.address) expect(pubkey.toBase58()).toBe(node.address);
    return [{ pubkey, isSigner: node.signer === true, isWritable: node.writable === true }];
  });
}
function compare(name: string, args: object, manual: TransactionInstruction): void {
  const definition = idl.instructions.find(row => row.name === name);
  expect(definition, `${name} must exist in the full accepted IDL`).toBeDefined();
  if (!definition) throw new Error(`Missing ${name}`);
  const encoded = new BorshInstructionCoder(idl as Idl).encode(name, args);
  expect(manual.programId.toBase58()).toBe(economy.toBase58());
  expect(manual.data).toEqual(encoded);
  expect(manual.keys).toEqual(idlMetas(definition.accounts));
}

function registration(): TransactionInstruction {
  const name = 'ABI Charter é', uri = 'https://example.invalid/charter-abi.json';
  const str = (s: string) => { const b = Buffer.from(s), n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n,b]); };
  const metadataHash = Buffer.from(keccak_256(Buffer.concat([Buffer.from('SKCHMET1'),str(name),str(uri)])));
  const original: CharterPacketInput['original'] = {
    creationIntentId: operation, clanId: clan, payer: leader.toBase58(),
    metadata: { name, uri, hash: metadataHash.toString('hex') }, admissionCommitment: commitment.toString('hex'),
    chain: { genesisHash:key(14).toBase58(), economyProgram:economy.toBase58(), craftProgram:craft.toBase58(),
      config:bound('config').toBase58(), craftControl:bound('craft_control').toBase58(), collection:bound('collection').toBase58(),
      collectionAuthority:bound('collection_authority').toBase58(), charter:bound('charter').toBase58(), asset:asset.toBase58(),
      assetBinding:bound('asset_binding').toBase58(), freezeAuthority:bound('freeze_authority').toBase58(),
      executor:bound('executor').toBase58(), creationReceipt:bound('creation_receipt').toBase58() },
  };
  // Existing consent serializer supplies only packet admission. The ABI expectation below uses independent IDL arguments.
  const candidate = encodeCharterRegistrationPermit({genesisHash:key(14),programId:economy,kind:5,permitId,wallet:leader,expiry,
    payloadHash:hashCharterRegistrationPayload({config:bound('config'),craftProgram:craft,craftControl:bound('craft_control'),
      collection:bound('collection'),collectionAuthority:bound('collection_authority'),charter:bound('charter'),asset,
      assetBinding:bound('asset_binding'),freezeAuthority:bound('freeze_authority'),executor:bound('executor'),
      creationReceipt:bound('creation_receipt'),clanId:clan,leader,creationIntentId:operation,metadataHash,admissionCommitment:commitment})});
  const addresses = [...new Map(Object.values(bindings).map(k => [k.toBase58(), k])).values()];
  const bytes = Buffer.alloc(56 + addresses.length * 32); bytes.writeUInt32LE(1);
  bytes.writeBigUInt64LE((1n << 64n)-1n,4); bytes.writeBigUInt64LE(100n,12);
  addresses.forEach((k,i) => k.toBuffer().copy(bytes,56+i*32));
  const lookup = {address:key(15).toBase58(),owner:AddressLookupTableProgram.programId.toBase58(),executable:false,dataHex:bytes.toString('hex'),slot:150};
  const packet = buildCharterCreationPacket({original,candidate,policySigner:key(16).toBase58(),policySignature:null,
    lookupTable:lookup,expectedLookupTable:{address:lookup.address,dataSha256:sha(bytes)},
    blockhash:key(17).toBase58(),blockhashSlot:150,lastValidBlockHeight:300,currentBlockHeight:200});
  const tx = VersionedTransaction.deserialize(Buffer.from(packet.unsignedTransactionHex,'hex'));
  const table = new AddressLookupTableAccount({key:new PublicKey(lookup.address),state:AddressLookupTableAccount.deserialize(bytes)});
  const instruction = TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:[table]}).instructions[2];
  if (!instruction) throw new Error('Registration instruction absent');
  return instruction;
}

// The immutable snapshot includes three instruction-level self-address fields.
// Map only those identity values for comparison; do not drop fields or normalize ABI data.
function retainedAtRelease(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(retainedAtRelease);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([name, field]) => [name,
    name === 'address' && field === retained.address ? economy.toBase58() : retainedAtRelease(field)]));
}

describe('K272 retained ABI with accepted E2 identity rotation', () => {
  it('pins the immutable pre-Charter snapshot and full B1 IDL bytes pending generated equality', () => {
    expect(sha(raw('./testFixtures/economyIdlPreCharter.json'))).toBe('02f1c5db7573d1d4c8919a478f3a02de6182c59a02996c65360693fc24cd6a89');
    expect(sha(raw('./idl/shardkeep_economy.json'))).toBe('f2b17e71af849e24b672a57ebb8da04f800d13a464fa574f353461b4148f9903');
  });
  it('pins accepted E2 instead of historical address retention and preserves metadata', () => {
    expect(idl.address).toBe(economy.toBase58());
    expect(idl.address).not.toBe(retained.address);
    expect(idl.metadata).toEqual(retained.metadata);
  });
  it('changes only the retired address field in comparison, never other payload strings', () => {
    expect(retainedAtRelease({ address: retained.address, payload: retained.address, nested: { address: core.toBase58() } }))
      .toEqual({ address: economy.toBase58(), payload: retained.address, nested: { address: core.toBase58() } });
  });
  for (const category of ['instructions','accounts','types','errors','events'] as const) {
    it(`preserves every retained ${category} entry structurally`, () => {
      const actual = new Map<string, unknown>(idl[category].map(row => [row.name, row] as [string, unknown]));
      expect(actual.size).toBe(idl[category].length);
      for (const old of retained[category]) expect(actual.get(old.name), `${category}:${old.name}`).toEqual(retainedAtRelease(old));
    });
  }
});
describe('K272 independent Charter manual builders versus IDL', () => {
  it('register: UTF-8 metadata, UUIDs, permit and ordered account metas', () => compare('register_charter', {
    clan_id:[...uuid(clan)],creation_intent_id:[...uuid(operation)],admission_commitment:[...commitment],
    name:'ABI Charter é',uri:'https://example.invalid/charter-abi.json',permit:idlPermit,
  }, registration()));
  it('transfer: distinct participants, u64 price, revision, fence and nested CPI metas', () => compare('settle_charter_transfer', {
    args:{clan_id:[...uuid(clan)],transfer_id:[...uuid(operation)],fence_id:[...uuid(fence)],expected_revision:revision,
      price_lamports:new BN('72623859790382856'),terms_hash:[...commitment],permit:idlPermit},
  }, buildCharterTransferInstruction({economy,craft,seller:leader,buyer,treasury},
    {clanId:clan,transferId:operation,fenceId:fence,expectedRevision:revision,priceLamports:72623859790382856n,termsHash:commitment},permit)));
  for (const action of ['set','clear'] as const) {
    it(`${action} lock: action-specific discriminator, unchanged ordered metas and arguments`, () => compare(`${action}_charter_lock`, {
      args:{clan_id:[...uuid(clan)],lock_id:[...uuid(operation)],expected_revision:revision,terms_hash:[...commitment],permit:idlPermit},
    }, buildCharterLockInstruction(economy,craft,leader,{clanId:clan,lockId:operation,expectedRevision:revision,termsHash:commitment,action},permit)));
  }
  it('retirement: permanent operation/fence, clearance and readonly Core-profile metas', () => compare('retire_charter', {
    args:{clan_id:[...uuid(clan)],retirement_id:[...uuid(operation)],fence_id:[...uuid(fence)],expected_revision:revision,
      clearance_hash:[...commitment],permit:idlPermit},
  }, buildCharterRetirementInstruction(economy,craft,leader,
    {clanId:clan,retirementId:operation,fenceId:fence,expectedRevision:revision,clearanceHash:commitment},permit)));
});
