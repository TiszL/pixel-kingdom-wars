/** D-141 single-player semantic validation. expectedInstructions must be locally
 * re-derived from finalized auction state and the authenticated player, never
 * copied from an untrusted wire. This function neither sends nor grants finality. */
import { createPublicKey, verify } from 'node:crypto';
import { ComputeBudgetProgram, Message, PACKET_DATA_SIZE, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PHASE_E_SEEKER_AUCTION_RUNTIME } from '@shardkeep/shared';
function need(ok:unknown,label:string):asserts ok { if(!ok) throw new Error(`Seeker signed transaction: ${label}`); }
function resolved(m:Message, index:number) {
 need(Number.isInteger(index)&&index>=0&&index<m.accountKeys.length,'account index');
 return {key:m.accountKeys[index]!.toBase58(),signer:m.isAccountSigner(index),writable:m.isAccountWritable(index)};
}
function instructions(m:Message) {
 return m.compiledInstructions.map(i=>({program:resolved(m,i.programIdIndex),accounts:i.accountKeyIndexes.map(k=>resolved(m,k)),data:Buffer.from(i.data)}));
}
export function assertPlayerSignedSeekerTx(wire:Uint8Array,wallet:PublicKey,expectedInstructions:readonly TransactionInstruction[],maxAddedFeeLamports:bigint):
 Readonly<{signature:string;mutation:'none'|'compute-budget-added'}> {
 need(wire instanceof Uint8Array && wire.length>65 && wire.length<=PACKET_DATA_SIZE,'wire size');
 need(typeof maxAddedFeeLamports==='bigint' && maxAddedFeeLamports>=0n
  && maxAddedFeeLamports<=BigInt(PHASE_E_SEEKER_AUCTION_RUNTIME.maxWalletAddedPriorityFeeLamports),'fee ceiling');
 need(Array.isArray(expectedInstructions) && expectedInstructions.length>0
  && !expectedInstructions.some(i=>i.programId.equals(ComputeBudgetProgram.programId)),'canonical instructions');
 const tx=VersionedTransaction.deserialize(wire); need(tx.version==='legacy','legacy only');
 need(Buffer.from(tx.serialize()).equals(Buffer.from(wire)),'canonical wire');
 const m=tx.message as Message;
 need(tx.signatures.length===1 && m.header.numRequiredSignatures===1 && m.header.numReadonlySignedAccounts===0
  && m.accountKeys[0]?.equals(wallet) && PublicKey.isOnCurve(wallet.toBytes()),'one player payer');
 need(m.accountKeys.length>0 && m.accountKeys.length<=256 && m.header.numReadonlyUnsignedAccounts<=m.accountKeys.length-1
  && new Set(m.accountKeys.map(k=>k.toBase58())).size===m.accountKeys.length,'account header');
 const expected=new TransactionMessage({payerKey:wallet,recentBlockhash:m.recentBlockhash,instructions:[...expectedInstructions]}).compileToLegacyMessage();
 need(expected.header.numRequiredSignatures===1,'expected one signer');
 const before=instructions(expected), after=instructions(m), budgetKey=ComputeBudgetProgram.programId.toBase58();
 let cursor=0, limit:bigint|null=null, price:bigint|null=null, added=false;
 const used=new Set<string>([wallet.toBase58()]);
 for(const instruction of after) {
  used.add(instruction.program.key); instruction.accounts.forEach(a=>used.add(a.key));
  if(instruction.program.key!==budgetKey) {
   const want=before[cursor++]; need(want && JSON.stringify({...instruction,data:undefined})===JSON.stringify({...want,data:undefined})
    && instruction.data.equals(want.data),'instructions or resolved privileges changed'); continue;
  }
  added=true; need(!instruction.program.signer&&!instruction.program.writable&&instruction.accounts.length===0,'budget accounts');
  const d=instruction.data;
  if(d.length===5 && d[0]===2 && limit===null) limit=BigInt(d.readUInt32LE(1));
  else if(d.length===9 && d[0]===3 && price===null) price=d.readBigUInt64LE(1);
  else throw new Error('Seeker signed transaction: unsupported or duplicate ComputeBudget');
 }
 need(cursor===before.length && used.size===m.accountKeys.length,'missing instructions or unused accounts');
 // Runtime maximum for price-only replies, as in native semanticPaymentSignature.
 const units=limit??1400000n, fee=((price??0n)*units+999999n)/1000000n;
 need(fee<=maxAddedFeeLamports,'priority fee above ceiling');
 const signature=tx.signatures[0]!;
 const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),wallet.toBuffer()]),format:'der',type:'spki'});
 need(signature.length===64 && verify(null,m.serialize(),publicKey,signature),'bad signature');
 return Object.freeze({signature:bs58.encode(signature),mutation:added?'compute-budget-added':'none'});
}
