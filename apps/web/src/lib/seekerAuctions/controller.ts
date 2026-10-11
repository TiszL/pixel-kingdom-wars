/** SA-4 state-in/callbacks-out controller for Opus's lazy Seeker Island mount.
 * No React, screen, timer, RPC connection, or first-paint registration lives here.
 * Keep one instance for the wallet session: its pending attempt must outlive a sheet. */
import {
 SeekerAuctionSourcedRoundViewSchema,SeekerAuctionPreparedSchema,SeekerAuctionTxStatusSchema,
 SeekerBidPrepareRequestSchema,SeekerWithdrawPrepareRequestSchema,
 type SeekerAuctionSourcedRoundView,type SeekerAuctionTxStatus,type SeekerBidPrepareRequest,type SeekerWithdrawPrepareRequest,
} from '@shardkeep/shared/seekerAuctionApi';
import {SeekerAuctionRefundsPageSchema,SeekerAuctionRefundsRequestSchema,type SeekerAuctionRefundsPage,type SeekerAuctionRefundsRequest} from '@shardkeep/shared/seekerAuctionRefundsApi';
import type {GameWallet} from '../../auth/useGameWallet';
import type {SeekerAuctionTransport} from './transport';
import {prepareSeekerAuctionSigning,prepareSeekerAuctionRefundSigning,signSeekerAuction,type SeekerAuctionIdentity,type SignedSeekerAuction} from './signing';

export type SeekerAuctionStateStatus='idle'|'loading'|'hidden'|'unavailable'|'ready'|'preparing'|'awaiting-wallet'|'submitting'|'pending'|'finalized'|'failed'|'expired';
export interface SeekerAuctionCosts {
 readonly incrementRaw:string;readonly networkFeeLamports:string;readonly newAccountRentLamports:string;
}
export interface SeekerAuctionOperation {
 readonly kind:'bid'|'withdraw';readonly wallet:string;readonly round:string;readonly spot:number;
 readonly newTotalRaw:string|null;readonly signature:string|null;readonly lastValidBlockHeight:string|null;
}
export interface SeekerAuctionState {
 readonly status:SeekerAuctionStateStatus;
 readonly view:SeekerAuctionSourcedRoundView|null;
 readonly refunds:{readonly status:'idle'|'loading'|'ready'|'unavailable';readonly page:SeekerAuctionRefundsPage|null;readonly error:string|null};
 readonly canWithdrawRefunds:boolean;
 readonly operation:SeekerAuctionOperation|null;
 readonly receipt:SeekerAuctionTxStatus|null;
 readonly costs:SeekerAuctionCosts|null;
 readonly error:string|null;
 /** General money-rail availability; server and signing checks still govern each row/action. */
 readonly canTransact:boolean;
 /** Offers an explicit new attempt only after matching, finalized proof of expiry. */
 readonly canRetry:boolean;
 /** No complete token-and-SOL budget snapshot is available; never invent a deficit. */
 readonly notEnough:null;
}
export interface SeekerAuctionControllerOptions {
 readonly transport:SeekerAuctionTransport;
 readonly wallet:()=>GameWallet;
 readonly identity:SeekerAuctionIdentity|null;
 readonly onChange?:(state:SeekerAuctionState)=>void;
}
type Intent={readonly kind:'bid';readonly request:SeekerBidPrepareRequest}|{readonly kind:'withdraw';readonly request:SeekerWithdrawPrepareRequest};
interface Attempt {
 readonly intent:Intent;readonly wallet:string;readonly identity:SeekerAuctionIdentity;readonly refundPage:SeekerAuctionRefundsPage|null;
 operation:SeekerAuctionOperation;signed:SignedSeekerAuction|null;walletStarted:boolean;submitStarted:boolean;
}
function need(value:unknown,message:string):asserts value {if(!value)throw Error(message);}
function text(error:unknown):string {return error instanceof Error?error.message.slice(0,240):'Seeker auction request unavailable';}
function freeze<T>(value:T):T {
 if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){
  for(const child of Object.values(value))freeze(child);Object.freeze(value);
 }
 return value;
}

/** Registry rows island.seeker.bid / island.seeker.withdraw; host seeker-island,
 * icon_skr, feature gate seeker.auctions. Host owns labels and TEST DATA ribbon. */
export class SeekerAuctionController {
 private state:SeekerAuctionState={status:'idle',view:null,refunds:{status:'idle',page:null,error:null},canWithdrawRefunds:false,operation:null,receipt:null,costs:null,error:null,canTransact:false,canRetry:false,notEnough:null};
 private attempt:Attempt|null=null;
 private busy=false;
 private polling=false;
 private loadRevision=0;
 private refundRevision=0;
 constructor(private readonly options:SeekerAuctionControllerOptions) {}

 private currentWallet():string|null {
  try{const wallet=this.options.wallet().publicKey?.toBase58();return wallet?SeekerAuctionSourcedRoundViewSchema.shape.wallet.parse(wallet):null;}catch{return null;}
 }
 private identity(view:SeekerAuctionSourcedRoundView|null):SeekerAuctionIdentity|null {
  const identity=this.options.identity;
  if(!identity||!view||Object.keys(identity).sort().join(' ')!=='decimals mint programId'
   ||identity.programId!==view.config.programId||identity.mint!==view.config.mint||identity.decimals!==view.config.decimals)return null;
  return {programId:identity.programId,mint:identity.mint,decimals:identity.decimals};
 }
 private refundIdentity(page:SeekerAuctionRefundsPage|null):SeekerAuctionIdentity|null {
  const identity=this.options.identity;
  return identity&&page&&Object.keys(identity).sort().join(' ')==='decimals mint programId'&&identity.programId===page.programId
   &&identity.mint===page.mint&&identity.decimals===page.decimals?{programId:identity.programId,mint:identity.mint,decimals:identity.decimals}:null;
 }
 private availability():Pick<SeekerAuctionState,'canTransact'|'canRetry'|'canWithdrawRefunds'> {
  const view=this.state.view,wallet=this.currentWallet();
  const ready=['ready','expired','finalized','failed'].includes(this.state.status);
  const sameOwner=!this.attempt||this.attempt.wallet===wallet;
  const canTransact=ready&&sameOwner&&view?.source==='chain'&&view.wallet===wallet&&this.identity(view)!==null;
  const page=this.state.refunds.page,refundReady=['idle','loading','ready','unavailable','expired','finalized','failed'].includes(this.state.status);
  const canWithdrawRefunds=refundReady&&sameOwner&&this.state.refunds.status==='ready'&&page?.wallet===wallet&&this.refundIdentity(page)!==null;
  return {canTransact,canRetry:this.state.status==='expired'&&(this.attempt?.refundPage?canWithdrawRefunds:canTransact),canWithdrawRefunds};
 }
 private displayedRefunds():SeekerAuctionState['refunds'] {
  const refunds=this.state.refunds;
  return refunds.page&&refunds.page.wallet!==this.currentWallet()?{status:'unavailable',page:null,error:'Refund wallet changed'}:refunds;
 }
 private publish(patch:Partial<SeekerAuctionState>):void {
  this.state={...this.state,...patch};this.state={...this.state,refunds:this.displayedRefunds(),...this.availability()};
  // A presentation callback exception cannot clear or replay an operation.
  try{this.options.onChange?.(this.snapshot());}catch{/* Keep the operation/evidence intact when a renderer fails. */}
 }
 readonly snapshot=():SeekerAuctionState=>freeze(structuredClone({...this.state,refunds:this.displayedRefunds(),...this.availability()}));

 private boundView(raw:unknown,wallet:string,round?:string):SeekerAuctionSourcedRoundView {
  const view=SeekerAuctionSourcedRoundViewSchema.parse(raw);
  need(view.wallet===wallet&&(round===undefined||view.round===round),'Auction view no longer matches the requested wallet or round');return view;
 }
 /** A failed probe is unavailable; only transport's explicit current 404 is hidden. */
 readonly load=async(round?:string):Promise<void>=>{
  if(this.busy||this.polling||this.state.status==='pending')return;
  const revision=++this.loadRevision,wallet=this.currentWallet();
  if(!wallet){this.publish({status:'unavailable',view:null,error:'Connect the authenticated wallet to read auctions'});return;}
  this.publish({status:'loading',error:null});
  try{
   if(round!==undefined)SeekerWithdrawPrepareRequestSchema.shape.round.parse(round);
   const value=round===undefined?await this.options.transport.current(wallet):await this.options.transport.round(wallet,round);
   if(revision!==this.loadRevision)return;
   need(this.currentWallet()===wallet,'Wallet changed while reading auctions');
   if(value===null){need(round===undefined,'Historical auction round unavailable');this.publish({status:'hidden',view:null,error:null});return;}
   const view=this.boundView(value,wallet,round);
   // A refresh cannot erase receipt/expiry evidence from an earlier attempt.
   const status=this.attempt&&this.state.receipt?.status==='finalized'?'finalized':this.attempt&&this.state.receipt?.status==='failed'?'failed':this.expired(this.attempt,this.state.receipt)?'expired':'ready';
   this.publish({status,view,error:null});
  }catch(error){if(revision===this.loadRevision)this.publish({status:'unavailable',view:null,error:text(error)});}
 };
 /** Separately coherent keyset pages; a failed check is never an empty refund list. */
 readonly loadRefunds=async(request:SeekerAuctionRefundsRequest={}):Promise<void>=>{
  if(this.busy||this.polling||this.state.status==='pending')return;
  const revision=++this.refundRevision,wallet=this.currentWallet(),retained=this.state.refunds.page?.wallet===wallet?this.state.refunds.page:null;
  this.publish({refunds:{status:'loading',page:retained,error:null}});
  try{
   need(wallet,'Connect the authenticated wallet to read refunds');const query=SeekerAuctionRefundsRequestSchema.parse(request);
   const page=SeekerAuctionRefundsPageSchema.parse(await this.options.transport.refunds(wallet,query));
   if(revision!==this.refundRevision)return;need(this.currentWallet()===wallet&&page.wallet===wallet,'Refund wallet changed');
   this.publish({refunds:{status:'ready',page,error:null}});
  }catch(error){if(revision===this.refundRevision)this.publish({refunds:{status:'unavailable',page:retained,error:`Older refunds could not be checked: ${text(error)}`}});}
 };
 readonly withdrawRefund=async(request:SeekerWithdrawPrepareRequest):Promise<void>=>{await this.begin({kind:'withdraw',request},true);};
 readonly bid=async(request:SeekerBidPrepareRequest):Promise<void>=>{await this.begin({kind:'bid',request});};
 readonly withdraw=async(request:SeekerWithdrawPrepareRequest):Promise<void>=>{await this.begin({kind:'withdraw',request});};

 private sameContext(attempt:Attempt):boolean {
  const identity=attempt.refundPage?this.refundIdentity(attempt.refundPage):this.identity(this.state.view);
  return this.currentWallet()===attempt.wallet&&identity?.programId===attempt.identity.programId
   &&identity.mint===attempt.identity.mint&&identity.decimals===attempt.identity.decimals;
 }
 private async begin(value:Intent,fromRefund=false):Promise<void> {
  if(this.busy||this.polling||!(fromRefund?this.availability().canWithdrawRefunds:this.availability().canTransact))return;
  this.busy=true;++this.loadRevision;++this.refundRevision;
  let attempt:Attempt|null=null;
  try{
   const intent:Intent=value.kind==='bid'?{kind:'bid',request:SeekerBidPrepareRequestSchema.parse(value.request)}:
    {kind:'withdraw',request:SeekerWithdrawPrepareRequestSchema.parse(value.request)};
   const refundPage=fromRefund?SeekerAuctionRefundsPageSchema.parse(this.state.refunds.page):null;
   const view=fromRefund?null:SeekerAuctionSourcedRoundViewSchema.parse(this.state.view),wallet=this.currentWallet(),identity=refundPage?this.refundIdentity(refundPage):this.identity(view);
   need(wallet&&identity&&(refundPage?refundPage.wallet===wallet:view?.source==='chain'&&view.wallet===wallet),'Auction signing identity is unavailable');
   if(refundPage)need(intent.kind==='withdraw'&&refundPage.entries.some(row=>row.round===intent.request.round&&row.spot===intent.request.spot),'Select a refund from the checked page');
   else need(intent.request.round===view!.round,'Load the requested auction round before preparing an action');
   const operation:SeekerAuctionOperation={kind:intent.kind,wallet,round:intent.request.round,spot:intent.request.spot,
    newTotalRaw:intent.kind==='bid'?intent.request.newTotalRaw:null,signature:null,lastValidBlockHeight:null};
   attempt={intent,wallet,identity,refundPage,operation,signed:null,walletStarted:false,submitStarted:false};this.attempt=attempt;
   this.publish({status:'preparing',operation,receipt:null,costs:null,error:null});
   const prepared=SeekerAuctionPreparedSchema.parse(intent.kind==='bid'?await this.options.transport.prepareBid(intent.request):await this.options.transport.prepareWithdraw(intent.request));
   need(this.sameContext(attempt),'Wallet or SKR identity changed during preparation');
   const proof=refundPage&&intent.kind==='withdraw'?await prepareSeekerAuctionRefundSigning({page:refundPage,request:intent.request,prepared,identity}):
    await prepareSeekerAuctionSigning(intent.kind==='bid'?{kind:'bid',request:intent.request,view:view!,prepared,identity}:
    {kind:'withdraw',request:intent.request,view:view!,prepared,identity});
   need(this.sameContext(attempt),'Wallet or SKR identity changed before approval');
   this.publish({status:'awaiting-wallet',costs:{incrementRaw:prepared.incrementRaw,networkFeeLamports:prepared.networkFeeLamports,newAccountRentLamports:prepared.newAccountRentLamports}});
   need(this.sameContext(attempt),'Wallet or SKR identity changed before approval');
   // Mark before crossing the asynchronous wallet boundary. Any uncertain return
   // remains held; this controller never automatically reopens the wallet.
   attempt.walletStarted=true;
   const signed=await signSeekerAuction(proof,this.options.wallet());
   attempt.signed=signed;attempt.operation={...operation,signature:signed.signature,lastValidBlockHeight:signed.lastValidBlockHeight};
   this.publish({status:'pending',operation:attempt.operation,error:null});
   if(!this.sameContext(attempt)){this.publish({error:'Wallet changed; transaction evidence is retained and has not been submitted to this session'});return;}
   attempt.submitStarted=true;this.publish({status:'submitting'});
   need(this.sameContext(attempt),'Wallet or SKR identity changed before submission');
   const receipt=await this.options.transport.submit(signed.submission);
   await this.acceptStatus(attempt,receipt);
  }catch(error){
   if(attempt?.walletStarted){this.publish({status:'pending',operation:attempt.operation,error:text(error)});}
   else{
    // Preparing is a read/quote operation, so an unsuccessful pre-wallet attempt
    // can be explicitly requested again without replaying a money effect.
    if(attempt&&this.attempt===attempt)this.attempt=null;
    this.publish({status:this.state.view||this.state.refunds.status==='ready'?'ready':'unavailable',operation:null,receipt:null,costs:null,error:text(error)});
   }
  }finally{this.busy=false;}
 }
 private expired(attempt:Attempt|null,receipt:SeekerAuctionTxStatus|null):boolean {
  return !!attempt?.operation.signature&&attempt.operation.lastValidBlockHeight!==null&&receipt?.signature===attempt.operation.signature
   &&receipt.status==='pending'&&receipt.found===false&&receipt.finalizedBlockHeight!==undefined
   &&BigInt(receipt.finalizedBlockHeight)>BigInt(attempt.operation.lastValidBlockHeight);
 }
 private async acceptStatus(attempt:Attempt,raw:unknown):Promise<void> {
  if(this.attempt!==attempt)return;
  const receipt=SeekerAuctionTxStatusSchema.parse(raw);
  need(receipt.signature===attempt.operation.signature,'Auction receipt signature does not match the retained transaction');
  if(receipt.status==='finalized'){
   this.publish({status:'finalized',receipt,error:null});
   // Preserve positive finality even if the follow-up view/RPC is unavailable.
   if(this.sameContext(attempt))try{
    if(attempt.refundPage){
     const page=SeekerAuctionRefundsPageSchema.parse(await this.options.transport.refunds(attempt.wallet));
     if(this.attempt===attempt&&this.sameContext(attempt)){need(page.wallet===attempt.wallet,'Refund wallet changed');this.publish({refunds:{status:'ready',page,error:null}});}
    }else{
     const rawView=await this.options.transport.current(attempt.wallet);
     if(this.attempt===attempt&&this.sameContext(attempt)){
      need(rawView!==null,'Auction view unavailable after finalization');this.publish({view:this.boundView(rawView,attempt.wallet)});
     }
    }
   }catch(error){if(this.attempt===attempt)this.publish({error:text(error),...(attempt.refundPage?{refunds:{status:'unavailable' as const,page:this.state.refunds.page,error:`Older refunds could not be checked: ${text(error)}`}}:{})});}
  }else if(receipt.status==='failed')this.publish({status:'failed',receipt,error:receipt.error});
  else this.publish({status:this.expired(attempt,receipt)?'expired':'pending',receipt,error:null});
 }
 /** One read per explicit poll call. Unknown/missing height is pending forever;
  * only found=false and a strictly greater finalized height can offer a retry. */
 readonly poll=async():Promise<void>=>{
  const attempt=this.attempt;
  if(this.busy||this.polling||!attempt?.operation.signature||!['pending','expired'].includes(this.state.status))return;
  if(!this.sameContext(attempt)){this.publish({error:'Reconnect the original wallet to check its retained transaction'});return;}
  this.polling=true;
  try{await this.acceptStatus(attempt,await this.options.transport.status(attempt.operation.signature));}
  catch(error){if(this.attempt===attempt)this.publish({error:text(error)});}
  finally{this.polling=false;}
 };
}
