/** Current in-memory SDK unit packets and a fixture-only executable bank. */
import {createHash} from 'node:crypto';
import {Message,PublicKey,SYSVAR_CLOCK_PUBKEY,type VersionedTransactionResponse} from '@solana/web3.js';
import {MiningTaxClaimPreparationSchema} from '@shardkeep/shared/miningTaxClaimsApi';
import {createCurrentMiningTaxFixture} from './miningTaxPreparationCurrent';
import type {MiningTaxFailureRpc} from '../miningTaxFailure';
const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),sysvar=new PublicKey('Sysvar1111111111111111111111111111111111111');
export function createMiningTaxFailureFixture(kind:'claim'|'combined'|'split'='combined',ordinal=0){
 const fixture=createCurrentMiningTaxFixture(kind),preparation=MiningTaxClaimPreparationSchema.parse(fixture.preparation),program=new PublicKey(preparation.identity.programId);
 const programData=PublicKey.findProgramAddressSync([program.toBuffer()],loader)[0],binary=Buffer.alloc(46);binary.writeUInt32LE(3);binary.writeBigUInt64LE(BigInt(preparation.source.reviewedDeploymentSlot),4);binary[12]=0;binary[45]=1;
 preparation.source.reviewedProgramDataSha256=createHash('sha256').update(binary).digest('hex');
 const programBytes=Buffer.alloc(36);programBytes.writeUInt32LE(2);programData.toBuffer().copy(programBytes,4);
 let slot=Math.max(preparation.source.snapshotSlot,preparation.source.blockhashSlot)+2;
 const blockTime=Number(preparation.snapshot.unixTimestamp)+1,clock=Buffer.alloc(40);clock.writeBigUInt64LE(BigInt(slot));clock.writeBigInt64LE(BigInt(blockTime)+1n,32);
 const row=(address:PublicKey,owner:PublicKey,executable:boolean,data:Buffer)=>({address,owner,executable,data});
 const bank=[row(program,loader,true,programBytes),row(programData,loader,false,binary),row(SYSVAR_CLOCK_PUBKEY,sysvar,false,clock)];
 const wire=fixture.wires[ordinal]!,signedTransaction=Buffer.from(wire.signedTransactionHex,'hex'),message=Message.from(signedTransaction.subarray(65)),preBalances=message.accountKeys.map((_,i)=>i===0?1_000_000:0),postBalances=[...preBalances];postBalances[0]!-=5;
 const tx:VersionedTransactionResponse={slot:slot-1,blockTime,version:'legacy',transaction:{message,signatures:[wire.signature]},meta:{err:{InstructionError:[0,{Custom:9}]},fee:5,preBalances,postBalances,preTokenBalances:[],postTokenBalances:[]}};
 const calls={transactions:[] as string[],floors:[] as number[],addresses:[] as string[][],genesis:0};const signals:AbortSignal[]=[];
 const rpc:MiningTaxFailureRpc={getGenesisHash:async()=>{calls.genesis++;return preparation.identity.genesisHash;},getSlot:async()=>slot,
  getTransaction:async(signature,options)=>{if(options.commitment!=='finalized'||options.maxSupportedTransactionVersion!==0)throw Error('unfinalized fixture read');calls.transactions.push(signature);return signature===wire.signature?tx:null;},
  getMultipleAccountsInfoAndContext:async(keys,options)=>{calls.floors.push(options.minContextSlot);calls.addresses.push(keys.map(k=>k.toBase58()));return {context:{slot},value:keys.map(k=>bank.find(r=>r.address.equals(k))??null)};}};
 const trust={programId:program,keepMint:new PublicKey(preparation.identity.keepMint),reserveOwner:new PublicKey(preparation.identity.reserveOwner),expectedGenesisHash:preparation.identity.genesisHash,reviewedDeploymentSlot:preparation.source.reviewedDeploymentSlot,reviewedProgramDataSha256:preparation.source.reviewedProgramDataSha256};
 return {preparation,request:{preparation,ordinal,signedTransaction},trust,rpc,tx,bank,clock,calls,signals,connect:(signal:AbortSignal)=>{signals.push(signal);return rpc;},setSlot(next:number){slot=next;clock.writeBigUInt64LE(BigInt(next));}};
}
