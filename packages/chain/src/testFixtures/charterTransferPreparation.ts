/** Synthetic bank using the accepted byte layouts; never backend clearance.
 * Actual Core/SQL composition is a separate acceptance runner. */
import {AddressLookupTableAccount,AddressLookupTableProgram,Keypair,PublicKey} from '@solana/web3.js';
import {PHASE_E_CHARTER_TRANSFER} from '@shardkeep/shared';
import {preparationFixture,digest,sign} from './charterPreparation';
import {charterTransferAccounts,transferDisc} from '../charterTransferProtocol';
import type {CharterTransferOriginal,CharterTransferQuoteOptions} from '../charterTransferPreparation';
export function transferPreparationFixture(){
 const f=preparationFixture(),seller=Keypair.generate(),buyer=Keypair.generate(),treasury=Keypair.generate().publicKey;
 const original:CharterTransferOriginal={creation:f.saved,sale:{id:'12345678-1234-4678-9abc-def012345678',fenceId:'12345678-1234-4678-9abc-def012345679',
  seller:seller.publicKey.toBase58(),buyer:buyer.publicKey.toBase58(),treasury:treasury.toBase58(),expectedRevision:1,priceLamports:'101000003',termsHash:'11'.repeat(32)}};
 const permitId=Buffer.alloc(16,43),domain={economy:new PublicKey(f.saved.chain.economyProgram),craft:new PublicKey(f.saved.chain.craftProgram),seller:seller.publicKey,buyer:buyer.publicKey,treasury};
 const terms={clanId:f.saved.clanId,transferId:original.sale.id,fenceId:original.sale.fenceId,expectedRevision:1,priceLamports:101000003n,termsHash:Buffer.alloc(32,17)};
 const accounts=charterTransferAccounts(domain,terms,permitId);
 seller.publicKey.toBuffer().copy(f.get('charter').data,121);f.get('charter').data.writeUInt32LE(1,153);seller.publicKey.toBuffer().copy(f.get('asset').data,1);
 const config=Buffer.concat([transferDisc('account:CharterTransferConfig'),Buffer.of(1),accounts.config.toBuffer(),treasury.toBuffer(),Buffer.alloc(2),
  Buffer.of(PublicKey.findProgramAddressSync([Buffer.from('charter_transfer_config')],domain.economy)[1])]);config.writeUInt16LE(PHASE_E_CHARTER_TRANSFER.royaltyBps,73);
 f.rows.push({address:accounts.transferConfig,owner:domain.economy,executable:false,data:config});
 const keys=Object.values(accounts).filter((p,i,all)=>all.findIndex(k=>k.equals(p))===i),data=Buffer.alloc(56+keys.length*32);
 data.writeUInt32LE(1);data.writeBigUInt64LE((1n<<64n)-1n,4);data.writeBigUInt64LE(100n,12);keys.forEach((p,i)=>p.toBuffer().copy(data,56+i*32));
 const lookup={address:f.lookup.address,keys,data,pin:{address:f.lookup.address.toBase58(),dataSha256:digest(data)},
  table:()=>new AddressLookupTableAccount({key:f.lookup.address,state:AddressLookupTableAccount.deserialize(data)})};
 f.rpc.getAccountInfoAndContext=async()=>({context:{slot:150},value:{owner:AddressLookupTableProgram.programId,executable:false,data}});
 const options:CharterTransferQuoteOptions={trust:f.trust,expectedCurrentSigner:f.policy.publicKey.toBase58(),lookupTable:lookup.pin,
  costLimits:{maxNetworkFeeLamports:100000n,maxRentLamports:100000n,maxAdditionalLamports:200000n}};
 return {...f,original,seller,buyer,domain,terms,permitId,accounts,config,lookup,options,sign};
}
