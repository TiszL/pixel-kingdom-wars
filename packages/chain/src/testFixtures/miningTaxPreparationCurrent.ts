/** Test-only current ABI fixture. No RPC or captured evidence is produced.
 * Ephemeral SDK signing happens only when a test explicitly calls this helper;
 * historical JSON signatures and source artifacts are never rewritten. */
import {createHash} from 'node:crypto';
import {Keypair,Message,PublicKey,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {getAssociatedTokenAddressSync} from '@solana/spl-token';
import bs58 from 'bs58';
import {MiningTaxClaimPreparationSchema} from '@shardkeep/shared/miningTaxClaimsApi';
import vectors from './miningTaxPreparationCurrent.json' with {type:'json'};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

export function createCurrentMiningTaxFixture(kind:'claim'|'combined'|'split'='combined'){
 const preparation=MiningTaxClaimPreparationSchema.parse(structuredClone(vectors[kind]));
 const signer=Keypair.generate(),wallet=signer.publicKey,oldWallet=preparation.wallet,oldAta=preparation.identity.claimantAta;
 const ata=getAssociatedTokenAddressSync(new PublicKey(preparation.identity.keepMint),wallet);
 const replacements=new Map([[oldWallet,wallet],[oldAta,ata]]);
 preparation.wallet=wallet.toBase58();preparation.identity.originalWinner=preparation.wallet;preparation.identity.claimantAta=ata.toBase58();
 const wires=preparation.transactions.map(tx=>{
  const decoded=TransactionMessage.decompile(Message.from(Buffer.from(tx.messageHex,'hex')));
  decoded.payerKey=wallet;
  for(const instruction of decoded.instructions)for(const account of instruction.keys)account.pubkey=replacements.get(account.pubkey.toBase58())??account.pubkey;
  const message=decoded.compileToLegacyMessage(),bytes=message.serialize();
  tx.messageHex=Buffer.from(bytes).toString('hex');tx.messageSha256=hash(bytes);tx.packetBytes=bytes.length+65;
  for(const account of tx.newAccounts)account.address=replacements.get(account.address)?.toBase58()??account.address;
  const signed=new VersionedTransaction(message);signed.sign([signer]);const wire=signed.serialize();
  return {ordinal:tx.ordinal,signature:bs58.encode(signed.signatures[0]!),messageSha256:tx.messageSha256,wireSha256:hash(wire),signedTransactionHex:Buffer.from(wire).toString('hex')};
 });
 return {preparation,wires};
}
