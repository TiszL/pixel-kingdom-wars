/** Two real ABI terms for a fourteen-day local replay. Each boundary settlement
 * has a native Ed25519 permit and actual settler signature; no grace bypass. */
import { randomBytes } from 'node:crypto';
import anchorPkg, { type Idl } from '@coral-xyz/anchor';
import { Keypair, PublicKey, Ed25519Program, TransactionMessage, VersionedTransaction,
  SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import idl from '../idl/shardkeep_economy.json' with { type:'json' };
import { createMiningTermFixture } from './miningZeroWinnerTerm';
import { encodeSeekerActionPermit, hashSettleSeekerAuctionPayload, seekerAuthorityPda,
  seekerPermitReceiptPda } from '../seekerAuctionProtocol';
import { SEEKER_TERM_ACCOUNT_BYTES } from '../seekerTermAccounts';
import type { SeekerTermRpc } from '../seekerTerms';
const { BN, BorshAccountsCoder } = anchorPkg, coder = new BorshAccountsCoder(idl as Idl);
type Input = Parameters<typeof createMiningTermFixture>[0];
export function fundedMiningTerms(input: Omit<Input,'day'|'round'|'firstOperatingStart'|'winners'>, firstDay:string) {
  const first=BigInt(Date.parse(firstDay)/1000),policyKey=Keypair.generate(),settler=Keypair.generate();
  const mint=input.mint??Keypair.generate().publicKey,prizeOwner=input.prizeOwner??Keypair.generate().publicKey;
  const terms=new Map<bigint,Awaited<ReturnType<typeof createMiningTermFixture>>>();
  return async (day:string,slot:number) => {
    const start=BigInt(Date.parse(day)/1000),round=(start-first)/BigInt(PHASE_E_POLICY.seekerIsland.operatingTermSec);
    if(start<first)throw Error('Replay term precedes original fixture calendar');
    let t=terms.get(round);
    if(!t){
      const boundary=first+round*BigInt(PHASE_E_POLICY.seekerIsland.operatingTermSec);
      t=await createMiningTermFixture({...input,mint,prizeOwner,day:new Date(Number(boundary)*1000).toISOString().slice(0,10),round,firstOperatingStart:first});
      const state=t,program=t.policy.programId,auth=state.store.get(seekerAuthorityPda(program).toBase58())!;
      const authority=coder.decode('SeekerAuthority',auth.data);authority.current_policy_key=policyKey.publicKey;
      (await coder.encode('SeekerAuthority',authority)).copy(auth.data);
      const old=[...state.bodies.values()],layout=idl.instructions.find(i=>i.name==='settle_auction_with_permit')!,history=new Map<string,string>();
      state.bodies.clear();
      for(const original of old){
        const originalIx=original.transaction.message.compiledInstructions[0]!,keys=original.transaction.message.getAccountKeys();
        const accounts=originalIx.accountKeyIndexes.map(i=>keys.get(i)!);accounts[0]=settler.publicKey;
        const auctionKey=accounts[3]!,auctionRow=state.store.get(auctionKey.toBase58())!,auction=coder.decode('Auction',auctionRow.data);
        const shifted=BigInt(original.slot)+round*10000n;auction.settled_slot=new BN(shifted.toString());
        auctionRow.data=Buffer.alloc(SEEKER_TERM_ACCOUNT_BYTES.Auction);(await coder.encode('Auction',auction)).copy(auctionRow.data);
        const id=randomBytes(16),expiry=boundary+BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec);
        const permit=encodeSeekerActionPermit({genesisHash:state.policy.genesisHash,programId:program,kind:8,permitId:id,wallet:settler.publicKey,expiry,
          payloadHash:hashSettleSeekerAuctionPayload({auction:auctionKey,config:accounts[1]!,term:accounts[2]!,termsHash:Uint8Array.from(auction.terms_hash as number[]),highBid:0n,highBidder:null})});
        const data=Buffer.alloc(34);Buffer.from(layout.discriminator).copy(data);id.copy(data,8);data.writeBigInt64LE(expiry,24);data.writeUInt16LE(0,32);
        accounts.push(seekerAuthorityPda(program),seekerPermitReceiptPda(program,id),SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId);
        if(!accounts[8]!.equals(TOKEN_PROGRAM_ID))throw Error('Unexpected fixture SPL program');
        const message=new TransactionMessage({payerKey:settler.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[
          Ed25519Program.createInstructionWithPrivateKey({privateKey:policyKey.secretKey,message:permit}),
          {programId:program,data,keys:accounts.map((pubkey,i)=>({pubkey,isSigner:'signer' in layout.accounts[i]!&&layout.accounts[i]!.signer,
            isWritable:i!==7&&'writable' in layout.accounts[i]!&&layout.accounts[i]!.writable}))}]}).compileToLegacyMessage();
        const signed=new VersionedTransaction(message);signed.sign([settler]);const signature=bs58.encode(signed.signatures[0]!);
        history.set(auctionKey.toBase58(),signature);state.bodies.set(signature,{...original,slot:Number(shifted),blockTime:Number(boundary),transaction:{message,signatures:[signature]}});
      }
      const one=old[0]!,termAddress=one.transaction.message.getAccountKeys().get(one.transaction.message.compiledInstructions[0]!.accountKeyIndexes[2]!)!;
      const termRow=state.store.get(termAddress.toBase58())!,model=coder.decode('SeekerTerm',termRow.data);
      model.completed_slot=new BN((1099n+round*10000n).toString());termRow.data=Buffer.alloc(SEEKER_TERM_ACCOUNT_BYTES.SeekerTerm);(await coder.encode('SeekerTerm',model)).copy(termRow.data);
      state.rpc.getSignaturesForAddress=async address=>{const signature=history.get(address.toBase58()),tx=signature?state.bodies.get(signature):null;
        return signature&&tx?[{signature,slot:tx.slot,err:null,memo:null,confirmationStatus:'finalized'}]:[];};
      terms.set(round,state);
    }
    const state=t;
    const rpc:SeekerTermRpc={...state.rpc,getMultipleAccountsInfoAndContext:async addresses=>({context:{slot},value:addresses.map(address=>{
      const row=state.store.get(address.toBase58());if(!row)return null;const data=Buffer.from(row.data);
      if(address.equals(SYSVAR_CLOCK_PUBKEY)){data.writeBigUInt64LE(BigInt(slot));data.writeBigInt64LE(start+86400n,32);}return {...row,data};
    })})};
    return {connect:(_signal:AbortSignal)=>rpc,policy:state.policy,round,signatures:[...state.bodies.keys()]};
  };
}
