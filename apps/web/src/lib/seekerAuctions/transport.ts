/** SA-4 transport; import this subpath only when the auction surface opens.
 * JSON validation is not chain attestation. The authenticated server owns that
 * attestation; callers still bind every response to their current wallet. */
import {
 SeekerAuctionSourcedRoundViewSchema,SeekerBidPrepareRequestSchema,SeekerWithdrawPrepareRequestSchema,
 SeekerAuctionPreparedSchema,SeekerAuctionSubmitRequestSchema,SeekerAuctionTxStatusSchema,
 type SeekerAuctionSourcedRoundView,type SeekerBidPrepareRequest,type SeekerWithdrawPrepareRequest,
 type SeekerAuctionPrepared,type SeekerAuctionSubmitRequest,type SeekerAuctionTxStatus,
} from '@shardkeep/shared/seekerAuctionApi';

import {SeekerAuctionRefundsPageSchema,SeekerAuctionRefundsRequestSchema,type SeekerAuctionRefundsPage,type SeekerAuctionRefundsRequest} from '@shardkeep/shared/seekerAuctionRefundsApi';

export interface SeekerAuctionTransport {
 refunds(wallet:string,request?:SeekerAuctionRefundsRequest,signal?:AbortSignal):Promise<SeekerAuctionRefundsPage>;
 current(wallet:string,signal?:AbortSignal):Promise<SeekerAuctionSourcedRoundView|null>;
 round(wallet:string,round:string,signal?:AbortSignal):Promise<SeekerAuctionSourcedRoundView>;
 prepareBid(request:SeekerBidPrepareRequest,signal?:AbortSignal):Promise<SeekerAuctionPrepared>;
 prepareWithdraw(request:SeekerWithdrawPrepareRequest,signal?:AbortSignal):Promise<SeekerAuctionPrepared>;
 submit(request:SeekerAuctionSubmitRequest,signal?:AbortSignal):Promise<SeekerAuctionTxStatus>;
 status(signature:string,signal?:AbortSignal):Promise<SeekerAuctionTxStatus>;
}
export class SeekerAuctionTransportError extends Error {
 constructor(readonly status:number,readonly code:string){super(`Seeker auctions unavailable: ${code}`);this.name='SeekerAuctionTransportError';}
}
function need(value:unknown,message:string):asserts value {if(!value)throw Error(`Seeker auction transport: ${message}`);}
// Transport envelope bound, not economy tuning. Never allocate an unbounded
// response string before the strict child schemas have an opportunity to refuse.
const MAX_RESPONSE_BYTES=1_048_576;
async function json(response:Response):Promise<unknown> {
 const length=response.headers.get('content-length');
 if(length!==null)need(/^(0|[1-9][0-9]*)$/.test(length)&&BigInt(length)<=BigInt(MAX_RESPONSE_BYTES),'response byte limit');
 need(response.body,'missing response body');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{
  for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;
   if(size>MAX_RESPONSE_BYTES){await reader.cancel();throw Error('Seeker auction transport: response byte limit');}
   chunks.push(next.value);
  }
 }finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
}

/** No implicit polling, wallet access, request retries or idempotency mutation. */
export function createSeekerAuctionTransport(options:{readonly apiBase:string;readonly fetch?:typeof globalThis.fetch}):SeekerAuctionTransport {
 need(options&&typeof options.apiBase==='string'&&options.apiBase.length<=2048,'API base');
 const url=new URL(options.apiBase);need((url.protocol==='https:'||url.protocol==='http:')&&!url.username&&!url.password&&!url.search&&!url.hash,'API base');
 const base=url.toString().replace(/\/$/,''),fetcher=options.fetch??globalThis.fetch.bind(globalThis);
 async function request(path:string,body:SeekerBidPrepareRequest|SeekerWithdrawPrepareRequest|SeekerAuctionSubmitRequest|undefined,signal?:AbortSignal,probe=false):Promise<unknown> {
  const init:RequestInit={method:body===undefined?'GET':'POST',credentials:'include',cache:'no-store',redirect:'error',
   headers:body===undefined?{Accept:'application/json'}:{Accept:'application/json','Content-Type':'application/json'}};
  if(body!==undefined)init.body=JSON.stringify(body);if(signal!==undefined)init.signal=signal;
  const response=await fetcher(`${base}${path}`,init);
  need(!response.redirected,'redirect refused');
  if(probe&&response.status===404){await response.body?.cancel();return null;}
  if(!response.ok){
   let code=`HTTP_${response.status}`;
   try{const value=await json(response) as {error?:{code?:unknown}};
    if(typeof value?.error?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(value.error.code))code=value.error.code;
   }catch{/* An invalid error body never becomes a successful empty response. */}
   throw new SeekerAuctionTransportError(response.status,code);
  }
  return json(response);
 }
 const walletKey=(value:string)=>SeekerAuctionSourcedRoundViewSchema.shape.wallet.parse(value);
 const signatureKey=(value:string)=>SeekerAuctionTxStatusSchema.shape.signature.parse(value);
 function boundView(value:unknown,wallet:string,round?:string):SeekerAuctionSourcedRoundView {
  const parsed=SeekerAuctionSourcedRoundViewSchema.parse(value);
  need(parsed.wallet===wallet&&(round===undefined||parsed.round===round),'response wallet or round changed');return parsed;
 }
 function boundStatus(value:unknown,signature?:string):SeekerAuctionTxStatus {
  const parsed=SeekerAuctionTxStatusSchema.parse(value);need(signature===undefined||parsed.signature===signature,'response signature changed');return parsed;
 }
 return Object.freeze({
  async refunds(wallet:string,value:SeekerAuctionRefundsRequest={},signal?:AbortSignal){
   const bound=walletKey(wallet),query=SeekerAuctionRefundsRequestSchema.parse(value),suffix=query.after?`?round=${query.after.round}&spot=${query.after.spot}`:'';
   const page=SeekerAuctionRefundsPageSchema.parse(await request(`/seeker/auctions/refunds${suffix}`,undefined,signal));
   need(page.wallet===bound,'refund response wallet changed');
   if(query.after)need(page.entries.every(row=>BigInt(row.round)>BigInt(query.after!.round)||row.round===query.after!.round&&row.spot>query.after!.spot),'refund page did not advance');
   return page;
  },
  async current(wallet:string,signal?:AbortSignal){const bound=walletKey(wallet),value=await request('/seeker/auctions/current',undefined,signal,true);return value===null?null:boundView(value,bound);},
  async round(wallet:string,round:string,signal?:AbortSignal){const bound=walletKey(wallet),r=SeekerWithdrawPrepareRequestSchema.shape.round.parse(round);return boundView(await request(`/seeker/auctions/round/${r}`,undefined,signal),bound,r);},
  async prepareBid(value:SeekerBidPrepareRequest,signal?:AbortSignal){const body=SeekerBidPrepareRequestSchema.parse(value);return SeekerAuctionPreparedSchema.parse(await request('/seeker/auctions/bids/prepare',body,signal));},
  async prepareWithdraw(value:SeekerWithdrawPrepareRequest,signal?:AbortSignal){const body=SeekerWithdrawPrepareRequestSchema.parse(value);return SeekerAuctionPreparedSchema.parse(await request('/seeker/auctions/withdrawals/prepare',body,signal));},
  async submit(value:SeekerAuctionSubmitRequest,signal?:AbortSignal){const body=SeekerAuctionSubmitRequestSchema.parse(value);return boundStatus(await request('/seeker/auctions/submit',body,signal),'signature' in body?body.signature:undefined);},
  async status(signature:string,signal?:AbortSignal){const bound=signatureKey(signature);return boundStatus(await request(`/seeker/auctions/tx/${bound}`,undefined,signal),bound);},
 });
}
