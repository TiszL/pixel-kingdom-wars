/** Actual qualification/preparation plus raw finalized backing and throwaway signing. */
import { randomUUID } from 'node:crypto';
import { Keypair,PublicKey,VersionedMessage,VersionedTransaction } from '@solana/web3.js';
import { withInitialFreePublicationFixture } from './initialFreePublication';
import { createInitialFreePublicationPreparer,type PreparedMiningPublication } from '../../src/mining/publicationPreparation';
import { createMiningPublicationOutbox,type MiningPublicationOutboxRequest,type MiningPublicationOutboxService } from '../../src/mining/publicationOutbox';
type Base=Parameters<Parameters<typeof withInitialFreePublicationFixture>[0]>[0];
export type MiningPublicationOutboxFixture=Omit<Base,'request'> & {
 request:MiningPublicationOutboxRequest;prepared:PreparedMiningPublication;signer:Keypair;
 outbox:MiningPublicationOutboxService;sign:()=>Uint8Array;
};
async function ready(f:Base):Promise<MiningPublicationOutboxFixture>{
 const signer=Keypair.generate();f.backing.model.publisher=signer.publicKey;f.backing.model.flags=0;await f.backing.config();
 const request={epochId:f.request.epochId,attemptKey:randomUUID()};
 const prepare=createInitialFreePublicationPreparer(f.conn.db,{sources:f.sources,signer:signer.publicKey,blockhashSource:()=>({getGenesisHash:async()=>f.backing.trust.expectedGenesisHash,getLatestBlockhashAndContext:async()=>({context:{slot:2000},value:{blockhash:new PublicKey(Buffer.alloc(32,91)).toBase58(),lastValidBlockHeight:2200}})})});
 const prepared=await prepare({...f.request,...request});if(prepared.status!=='prepared')throw Error('fixture must prepare');
 // A later finalized same-bank snapshot, with its actual Clock slot kept bound.
 const bank=2100;f.backing.rows[7]!.data.writeBigUInt64LE(BigInt(bank));
 f.backing.reader.getSlot=async()=>bank+10;f.backing.reader.getMultipleAccountsInfoAndContext=async()=>({context:{slot:bank+10},value:f.backing.rows});
 f.backing.rows[7]!.data.writeBigUInt64LE(BigInt(bank+10));
 const outbox=createMiningPublicationOutbox(f.conn.db,{reader:f.backing.reader,trust:f.backing.trust});
 const sign=()=>{const tx=new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(prepared.intentHex,'hex')));tx.sign([signer]);return tx.serialize();};
 return {...f,request,prepared,signer,outbox,sign};
}
export async function withMiningPublicationOutboxFixture(run:(f:MiningPublicationOutboxFixture)=>Promise<void>,options:{quantities?:readonly number[]}={}){return withInitialFreePublicationFixture(async f=>run(await ready(f)),options);}
