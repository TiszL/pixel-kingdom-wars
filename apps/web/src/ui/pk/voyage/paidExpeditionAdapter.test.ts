import {describe,expect,it} from 'vitest';
import {paidStarterRoutePreview} from '@shardkeep/shared/paidStarterExpeditions';
import type {PaidStarterExpeditionView} from '@shardkeep/shared/paidStarterExpeditionApi';
import {view,identity,id,start,proof} from '../../../lib/starterExpedition/fixtures.test-support';
import type {StarterExpeditionOperation} from '../../../lib/starterExpedition/journal';
import {paidDepartureModel,expeditionReceiptStage} from './paidExpeditionAdapter';
const snapshot=()=>({view:view(),balances:{keep:'0',shards:'0',keepRate:1},enabled:true});
const paid=():PaidStarterExpeditionView=>({wallet:identity.wallet,baseId:id(1),realm:0,serverNow:view().serverNow,authorization:'none',acceptingDepartures:true,route:paidStarterRoutePreview('paid_frostveil'),coverage:{status:'covered',observedAt:view().serverNow,expiresAt:'1999999999'}});
const model=(s=snapshot(),p:PaidStarterExpeditionView|null=paid(),realm:number|null=0,pending=false)=>paidDepartureModel(s,p,identity.wallet,id(1),realm,false,pending);
describe('paid expedition snapshot boundary — authored, unrun',()=>{
  it('observed coverage permits review without inventing a departure charge',()=>{expect(model()).toMatchObject({canReview:true,departurePrice:null,reason:null});});
  it('an unselected realm cannot reuse an earlier preview',()=>{expect(model(snapshot(),paid(),null).canReview).toBe(false);});
  it('a preview from another realm cannot authorize the selected route',()=>{expect(model(snapshot(),{...paid(),realm:1}).canReview).toBe(false);});
  it('a preview from another wallet or kingdom is hidden',()=>{
    expect(model(snapshot(),{...paid(),wallet:'other'}).route).toBeNull();expect(model(snapshot(),{...paid(),baseId:id(9)}).route).toBeNull();
  });
  it('a stock snapshot from another wallet or kingdom cannot enable departure',()=>{
    const s=snapshot();s.view={...s.view,wallet:'other'};expect(model(s).canReview).toBe(false);
    s.view={...view(),baseId:id(9)};expect(model(s).canReview).toBe(false);
  });
  it('missing and expired coverage remain blocked rather than priced as a permit',()=>{
    for(const coverage of [{status:'unavailable' as const},{status:'blocked' as const,reason:'EXPIRED' as const},{status:'blocked' as const,reason:'NO_COVERAGE' as const}])expect(model(snapshot(),{...paid(),coverage})).toMatchObject({canReview:false,departurePrice:null});
  });
  it('saved originals take precedence over a fresh covered preview',()=>{expect(model(snapshot(),paid(),0,true).reason).toBe('Check the saved departure first.');});
  it('server pauses and missing current observations cannot begin a trip',()=>{
    expect(model({...snapshot(),enabled:false}).canReview).toBe(false);expect(model(snapshot(),{...paid(),acceptingDepartures:false}).canReview).toBe(false);expect(model(snapshot(),null).canReview).toBe(false);
    expect(paidDepartureModel(null,paid(),identity.wallet,id(1),0,false,false).canReview).toBe(false);
  });
  it('a local deadline never establishes an actual return',()=>{
    const operation:StarterExpeditionOperation={command:start,attemptRevision:1,proof:proof(start,true,false),refusal:null};
    expect(expeditionReceiptStage(operation)).toBe('ACCEPTED');expect(expeditionReceiptStage({...operation,proof:proof(start,true,true)})).toBe('RETURNED');
  });
  it('uncertain attempts stay check-only and are never labelled unsent',()=>{
    expect(expeditionReceiptStage({command:start,attemptRevision:1,proof:null,refusal:null})).toBe('CHECKING');
    expect(expeditionReceiptStage({command:start,attemptRevision:null,proof:null,refusal:null})).toBe('DRAFT');
  });
});
