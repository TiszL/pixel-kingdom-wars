import { AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Message, MessageV0, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { PHASE_E_MINING_CLAIM_FORMAT } from '@shardkeep/shared';
import { MiningClaimPreparationViewSchema, type MiningClaimPreparationView } from '@shardkeep/shared/miningClaimsApi';
import type { GameWallet } from '../../auth/useGameWallet';

/** Independent application pins; never construct these from a preparation response. */
export interface MiningClaimSigningTrust {
  readonly genesisHash: string; readonly programId: string; readonly configAddress: string;
  readonly keepMint: string; readonly reserveOwner: string;
  readonly orderedLookupTable?: Readonly<{address:string;dataSha256:string}>;
}
export interface SignedMiningClaim { readonly ordinal: number; readonly wire: string; readonly signature: string }
export interface PreparedMiningClaimSigning { readonly ordinal: number; readonly wallet: string }
export class MiningClaimSigningError extends Error {
  constructor(readonly code: 'INPUT' | 'TRUST' | 'UNSUPPORTED' | 'MESSAGE' | 'WALLET' | 'SIGNATURE') {
    super(`Mining claim signing refused: ${code}`); this.name = 'MiningClaimSigningError';
  }
}
function requireValue(value: unknown, code: MiningClaimSigningError['code']): asserts value {
  if (!value) throw new MiningClaimSigningError(code);
}
const preparedClaims = new WeakMap<PreparedMiningClaimSigning, { preparation: MiningClaimPreparationView; message: Buffer }>();
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
// Classic SPL/ATA addresses and Anchor discriminators are protocol bytes, not game tuning.
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const CLAIM = [222, 36, 64, 123, 32, 17, 219, 8];
const OPEN_RECORDS = [119, 14, 190, 166, 208, 181, 158, 100];
function key(value: unknown): PublicKey {
  requireValue(typeof value === 'string' && value.length >= 32 && value.length <= 44, 'TRUST');
  try { const result = new PublicKey(value); requireValue(result.toBase58() === value, 'TRUST'); return result; }
  catch { throw new MiningClaimSigningError('TRUST'); }
}
function u64(value: string): Buffer { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; }
function pda(program: PublicKey, seed: string, tail?: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), ...(tail ? [tail] : [])], program)[0];
}
function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];
}
function preparation(value: MiningClaimPreparationView): MiningClaimPreparationView {
  // Zod's max() does not short-circuit child parsing: bound arrays before parsing.
  requireValue(value && typeof value === 'object' && Array.isArray(value.transactions) && value.transactions.length >= 1
    && value.transactions.length <= 2 && Array.isArray(value.proof) && value.proof.length <= 16, 'INPUT');
  const result = MiningClaimPreparationViewSchema.safeParse(value);
  requireValue(result.success, 'INPUT');
  requireValue(result.data.version === 2 || result.data.transactions.length === 1, 'UNSUPPORTED');
  return result.data;
}
/** Rebuild the accepted claim ABI without importing the server's Anchor/IDL graph.
 * This binds every displayed leaf/proof byte to the signed instruction. Merkle
 * membership, current root authority and positive delta remain server/program
 * checks; this browser helper does not claim to independently verify Keccak roots. */
function canonicalMessage(p: MiningClaimPreparationView, ordinal = 0): Buffer {
  try {
    const program = key(p.identity.programId), mint = key(p.identity.keepMint), wallet = key(p.wallet);
    requireValue(PublicKey.isOnCurve(wallet.toBytes()), 'MESSAGE');
    const config = pda(program, 'economy'), miner = pda(program, 'miner', wallet.toBytes()), renown = pda(program, 'renown', wallet.toBytes());
    requireValue(config.toBase58() === p.identity.configAddress, 'TRUST');
    const root = pda(program, 'alloc', u64(p.rootSequence)), destination = ata(wallet, mint), vault = ata(config, mint);
    const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
    const transaction = p.transactions[ordinal]; requireValue(transaction, 'INPUT');
    const setup = transaction.kind !== 'claim', claim = transaction.kind !== 'setup';
    const instructions: TransactionInstruction[] = [];
    if (p.version === 2) instructions.push(ComputeBudgetProgram.setComputeUnitLimit({units:PHASE_E_MINING_CLAIM_FORMAT.computeUnitLimit}));
    if (setup && p.needsAta) instructions.push(new TransactionInstruction({ programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [
      meta(wallet, true, true), meta(destination, true), meta(wallet), meta(mint), meta(SystemProgram.programId), meta(TOKEN_PROGRAM),
    ] }));
    if (setup && p.needsMinerRecords) instructions.push(new TransactionInstruction({ programId: program,
      data: Buffer.concat([Buffer.from(OPEN_RECORDS), wallet.toBuffer()]), keys: [meta(wallet, true, true), meta(miner, true), meta(renown, true), meta(SystemProgram.programId)] }));
    const count = Buffer.alloc(4); count.writeUInt32LE(p.proof.length);
    if (claim) instructions.push(new TransactionInstruction({ programId: program, keys: [meta(wallet, false, true), meta(config, true), meta(root, true),
      meta(miner, true), meta(renown, true), meta(vault, true), meta(destination, true), meta(mint), meta(TOKEN_PROGRAM)],
    data: Buffer.concat([Buffer.from(CLAIM), u64(p.rootSequence), u64(p.leaf.cumulativeKeepBaseUnits), u64(p.leaf.cumulativeRenown), u64(p.leaf.cumulativeDays), count,
      ...p.proof.map(n => Buffer.concat([Buffer.from(n.hash, 'hex'), u64(n.sumBaseUnits), Buffer.from([n.isLeft ? 1 : 0])]))]) }));
    const compiler = new TransactionMessage({payerKey:wallet,recentBlockhash:transaction.blockhash,instructions});
    let expected: Uint8Array;
    if(p.version===2){
      const f=p.format,raw=Buffer.from(f.lookupTable.dataHex,'hex'),state=AddressLookupTableAccount.deserialize(raw);
      requireValue(f.lookupTable.owner===AddressLookupTableProgram.programId.toBase58() && Buffer.from(sha256(raw)).toString('hex')===f.expectedLookupTable.dataSha256
        && state.authority===undefined && state.deactivationSlot===(1n<<64n)-1n && state.lastExtendedSlot<f.lookupTable.slot
        && f.lookupTable.slot<=f.blockhashContextSlot && state.lastExtendedSlotStartIndex<=3
        && state.addresses.length===3 && state.addresses.every((k,i)=>k.equals([config,vault,mint][i]!)), 'MESSAGE');
      expected=compiler.compileToV0Message([new AddressLookupTableAccount({key:key(f.lookupTable.address),state})]).serialize();
    }else expected=compiler.compileToLegacyMessage().serialize();
    const message=Buffer.from(transaction.message,'base64');
    requireValue(message.length<=1167 && same(message,expected), 'MESSAGE');
    const parsed=p.version===2?MessageV0.deserialize(message):Message.from(message);
    const accounts=parsed instanceof MessageV0?parsed.staticAccountKeys:parsed.accountKeys;
    requireValue(parsed.header.numRequiredSignatures===1 && parsed.header.numReadonlySignedAccounts===0
      && accounts[0]?.equals(wallet) && same(parsed.serialize(),message),'MESSAGE');
    return message;
  } catch (error) { if (error instanceof MiningClaimSigningError) throw error; throw new MiningClaimSigningError('MESSAGE'); }
}
/** No clock/RPC here. The controller owns current quote, network and height admission. */
export function prepareMiningClaimSigning(value: MiningClaimPreparationView, trust: MiningClaimSigningTrust, ordinal = 0): PreparedMiningClaimSigning {
  const p = preparation(value);
  requireValue(Number.isInteger(ordinal) && ordinal>=0 && ordinal<p.transactions.length && (p.version===2 || ordinal===0), 'UNSUPPORTED');
  requireValue(trust && typeof trust === 'object', 'TRUST');
  for (const name of ['genesisHash', 'programId', 'configAddress', 'keepMint', 'reserveOwner'] as const)
    requireValue(key(trust[name]).toBase58() === p.identity[name], 'TRUST');
  if(p.version===2) requireValue(trust.orderedLookupTable && trust.orderedLookupTable.address===p.format.expectedLookupTable.address
    && trust.orderedLookupTable.dataSha256===p.format.expectedLookupTable.dataSha256,'TRUST');
  // Approving setup also commits to the displayed full plan; reject a substituted remainder before spending setup SOL.
  if(p.version===2)for(let i=0;i<p.transactions.length;i++)canonicalMessage(p,i);
  const message = canonicalMessage(p,ordinal), prepared = Object.freeze({ ordinal, wallet: p.wallet });
  preparedClaims.set(prepared, { preparation: p, message });
  return prepared;
}
/** Recovery validates bytes, not current signing admission. Only canonical base64
 * is accepted, and the caller separately compares persisted ordinal/signature. */
export function verifySignedMiningClaim(value: MiningClaimPreparationView, raw: unknown, ordinal = 0): SignedMiningClaim {
  const p = preparation(value), message = canonicalMessage(p,ordinal);
  requireValue(typeof raw === 'string' && raw.length >= 88 && raw.length <= 1644 && raw.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw), 'INPUT');
  const wire = Buffer.from(raw, 'base64');
  requireValue(wire.length <= 1232 && wire.toString('base64') === raw, 'INPUT');
  requireValue(wire[0] === 1 && wire.length === 65 + message.length && same(wire.subarray(65), message), 'MESSAGE');
  if(p.version===2){
    requireValue(ed25519.verify(wire.subarray(1,65),message,key(p.wallet).toBytes(),{zip215:false}),'SIGNATURE');
    const tx=VersionedTransaction.deserialize(wire);requireValue(tx.signatures.length===1 && same(tx.serialize(),wire),'SIGNATURE');
    return Object.freeze({ordinal,wire:raw,signature:bs58.encode(wire.subarray(1,65))});
  }
  try {
    const tx = Transaction.from(wire), owner = key(p.wallet), signature = tx.signatures[0];
    requireValue(tx.signatures.length === 1 && tx.feePayer?.equals(owner) && signature?.publicKey.equals(owner)
      && signature.signature && same(tx.serializeMessage(), message) && tx.verifySignatures(true), 'SIGNATURE');
    requireValue(same(tx.serialize({ requireAllSignatures: true, verifySignatures: false }), wire), 'SIGNATURE');
    return Object.freeze({ ordinal: 0, wire: raw, signature: bs58.encode(signature!.signature!) });
  } catch (error) { if (error instanceof MiningClaimSigningError) throw error; throw new MiningClaimSigningError('SIGNATURE'); }
}
/** Wallet approval only. A valid signature is returned even if account/time/view
 * changes during approval, so the controller can durably retain it first. */
export async function signMiningClaim(prepared: PreparedMiningClaimSigning, wallet: GameWallet): Promise<SignedMiningClaim> {
  const proof = preparedClaims.get(prepared);
  requireValue(proof, 'INPUT');
  const signer = wallet.signTransaction;
  requireValue(wallet.publicKey?.toBase58() === proof.preparation.wallet && typeof (proof.preparation.version===2?wallet.signVersionedTransaction:signer) === 'function', 'WALLET');
  // Populate the required signature slot up front: adding its public key later
  // invalidates web3's message cache and can reorder legacy account keys.
  if(proof.preparation.version===2){
    const tx=new VersionedTransaction(MessageV0.deserialize(proof.message)),signed=await wallet.signVersionedTransaction!(tx);
    requireValue(signed instanceof VersionedTransaction && signed.signatures.length===1 && same(signed.message.serialize(),proof.message),'MESSAGE');
    return verifySignedMiningClaim(proof.preparation,Buffer.from(signed.serialize()).toString('base64'),prepared.ordinal);
  }
  const tx = Transaction.populate(Message.from(proof.message), [bs58.encode(new Uint8Array(64))]);
  requireValue(same(tx.serializeMessage(), proof.message), 'MESSAGE');
  const signed = await signer!.call(wallet, tx);
  requireValue(signed instanceof Transaction && signed.instructions.length <= 3 && signed.signatures.length === 1
    && signed.instructions.every(ix => ix.keys.length <= 9 && ix.data.length <= 700), 'MESSAGE');
  requireValue(signed.recentBlockhash === proof.preparation.transactions[0]!.blockhash, 'MESSAGE');
  requireValue(same(signed.serializeMessage(), proof.message), 'MESSAGE');
  try {
    // Verify through the same path used for durable replay. The private DTO is a
    // parsed deep copy, independent of caller mutations while approval was open.
    return verifySignedMiningClaim(proof.preparation, signed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'));
  } catch (error) { if (error instanceof MiningClaimSigningError) throw error; throw new MiningClaimSigningError('SIGNATURE'); }
}
