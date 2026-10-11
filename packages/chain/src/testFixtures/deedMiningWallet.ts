import { vi,type Mock } from 'vitest';
import { PublicKey,SystemProgram,TransactionMessage,type VersionedTransactionResponse } from '@solana/web3.js';
import { Key,MPL_CORE_PROGRAM_ID,getCreateCollectionV1InstructionDataSerializer,getCreateV2InstructionDataSerializer,getTransferV1InstructionDataSerializer } from '@metaplex-foundation/mpl-core';
import { publicKey } from '@metaplex-foundation/umi';
import { getAssetV1AccountDataSerializer } from '@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData';
import { getCollectionV1AccountDataSerializer } from '@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData';
import bs58 from 'bs58';
import { readDeedMiningWalletEvidence,type DeedMiningWalletReader,type DeedMiningWalletInput } from '../deedMiningWalletEvidence';
export const key=(n:number)=>{const b=Buffer.alloc(32);b.writeUInt32LE(n);return new PublicKey(b);};
export const core=new PublicKey(MPL_CORE_PROGRAM_ID),collection=key(1),creator=key(2),wallet=key(3),other=key(4),asset=key(5),genesis=key(6).toBase58();let seq=0;
function sig(){const b=Buffer.alloc(64,7);b.writeUInt32LE(++seq);return bs58.encode(b);}
export function tx(kind:'collection'|'mint'|'transfer',slot:number,recipient=other,id=asset,from=other,belongs=collection):VersionedTransactionResponse{
 const keys=kind==='collection'?[collection,creator,creator,SystemProgram.programId]:kind==='mint'?[id,belongs,creator,creator,recipient,core,SystemProgram.programId,core]:[id,belongs,creator,from,recipient];
 const data=kind==='collection'?getCreateCollectionV1InstructionDataSerializer().serialize({name:'Deeds',uri:''}):kind==='mint'?getCreateV2InstructionDataSerializer().serialize({name:'Deed',uri:'',dataState:0}):getTransferV1InstructionDataSerializer().serialize({});
 const message=new TransactionMessage({payerKey:creator,recentBlockhash:key(9).toBase58(),instructions:[{programId:core,keys:keys.map((pubkey,i)=>({pubkey,isSigner:pubkey.equals(creator)||(kind!=='transfer'&&i===0),isWritable:i===0||(kind!=='collection'&&i===1)||pubkey.equals(creator)})),data:Buffer.from(data)}]}).compileToV0Message();
 return {version:0,slot,blockTime:slot*10,transaction:{message,signatures:Array.from({length:message.header.numRequiredSignatures},sig)},meta:{err:null,fee:1,preBalances:[],postBalances:[],innerInstructions:[]}};
}
function account(data:Uint8Array){return {owner:core,executable:false,lamports:1,rentEpoch:0,data:Buffer.from(data)};}
type FixtureAccount=ReturnType<typeof account>;
type FixtureEntry={pubkey:PublicKey;account:FixtureAccount};
type FixtureRow={signature:string;slot:number;blockTime:number|null|undefined;err:NonNullable<VersionedTransactionResponse['meta']>['err'];confirmationStatus:string};
export interface MiningWalletFixtureReader {
 getGenesisHash:Mock<()=>Promise<string>>;
 getSlot:Mock<()=>Promise<number>>;
 getAccountInfoAndContext:Mock<()=>Promise<{context:{slot:number};value:FixtureAccount}>>;
 getProgramAccounts:Mock<()=>Promise<{context:{slot:number};value:FixtureEntry[]}>>;
 getBlockTime:Mock<(slot:number)=>Promise<number|null>>;
 getBlockSignatures:Mock<(slot:number)=>Promise<{blockTime:number;signatures:(string|undefined)[]}>>;
 getTransaction:Mock<(signature:string)=>Promise<VersionedTransactionResponse|null>>;
 getSignaturesForAddress:Mock<(address:PublicKey)=>Promise<FixtureRow[]>>;
}
export interface MiningWalletFixture {
 reader:MiningWalletFixtureReader;entries:FixtureEntry[];input:DeedMiningWalletInput;transactions:VersionedTransactionResponse[];
 read:()=>ReturnType<typeof readDeedMiningWalletEvidence>;
}
export interface CalendarMiningWalletFixture extends MiningWalletFixture {collection:string;expectedGenesisHash:string;assetId:string}
export function fixture(txs=[tx('collection',1),tx('mint',10)],assets=[{id:asset,owner:other}]):MiningWalletFixture{
 const collectionInfo=account(getCollectionV1AccountDataSerializer().serialize({key:Key.CollectionV1,updateAuthority:publicKey(creator.toBase58()),name:'Deeds',uri:'',numMinted:assets.length,currentSize:assets.length}));
 const entries=assets.map(a=>({pubkey:a.id,account:account(getAssetV1AccountDataSerializer().serialize({key:Key.AssetV1,owner:publicKey(a.owner.toBase58()),updateAuthority:{__kind:'Collection',fields:[publicKey(collection.toBase58())]},name:'Deed',uri:'',seq:null}))}));
 const reader:MiningWalletFixtureReader={getGenesisHash:vi.fn().mockResolvedValue(genesis),getSlot:vi.fn().mockResolvedValue(25),getAccountInfoAndContext:vi.fn().mockResolvedValueOnce({context:{slot:19},value:collectionInfo}).mockResolvedValueOnce({context:{slot:21},value:collectionInfo}),getProgramAccounts:vi.fn().mockResolvedValue({context:{slot:20},value:entries}),
 getBlockTime:vi.fn().mockImplementation(async(s:number)=>s*10),getBlockSignatures:vi.fn().mockImplementation(async(s:number)=>({blockTime:s*10,signatures:txs.filter(t=>t.slot===s).map(t=>t.transaction.signatures[0])})),
 getTransaction:vi.fn().mockImplementation(async(s:string)=>txs.find(t=>t.transaction.signatures[0]===s)??null),getSignaturesForAddress:vi.fn().mockImplementation(async(address:PublicKey)=>txs.filter(t=>t.transaction.message.staticAccountKeys.some(k=>k.equals(address))).map(t=>({signature:t.transaction.signatures[0]!,slot:t.slot,blockTime:t.blockTime,err:t.meta!.err,confirmationStatus:'finalized'})).reverse().sort((a,b)=>b.slot-a.slot))};
 const input={collection:collection.toBase58(),expectedGenesisHash:genesis,targetWallet:wallet.toBase58(),startAt:new Date(110_000),endAt:new Date(190_000)};
 return {reader,entries,input,transactions:txs,read:()=>readDeedMiningWalletEvidence(reader as unknown as DeedMiningWalletReader,input)};
}

/** Serialized test-only RPC fixture; no signing, network or eligibility shortcuts. */
export function createMiningWalletFixture(options:{targetWallet:string;startAt:Date;endAt:Date;scenario?:'none'|'out-back'|'continuous'|'minted-in-day'}):CalendarMiningWalletFixture{
 const target=new PublicKey(options.targetWallet),scenario=options.scenario??'none';
 const transactions=[tx('collection',1),tx('mint',scenario==='minted-in-day'?12:10,scenario==='continuous'||scenario==='minted-in-day'?target:other)];
 if(scenario==='out-back')transactions.push(tx('transfer',12,target),tx('transfer',13,other,asset,target));
 if(scenario==='minted-in-day')transactions.push(tx('transfer',13,other,asset,target));
 const f=fixture(transactions,[{id:asset,owner:scenario==='continuous'?target:other}]);
 const start=Math.floor(options.startAt.getTime()/1000),end=Math.ceil(options.endAt.getTime()/1000),width=end-start;
 const times:Record<number,number>={1:start-100,10:start-1,11:start,12:start+Math.floor(width/3),13:start+Math.floor(width*2/3),19:end,20:end+1,21:end+2,25:end+3};
 for(const item of transactions)item.blockTime=times[item.slot]!;
 f.reader.getBlockTime.mockImplementation(async(slot:number)=>times[slot]??null as never);
 f.reader.getBlockSignatures.mockImplementation(async(slot:number)=>({blockTime:times[slot]!,signatures:transactions.filter(t=>t.slot===slot).map(t=>t.transaction.signatures[0])}));
 Object.assign(f.input,{targetWallet:target.toBase58(),startAt:new Date(options.startAt),endAt:new Date(options.endAt)});
 return {...f,collection:collection.toBase58(),expectedGenesisHash:genesis,assetId:asset.toBase58()};
}
