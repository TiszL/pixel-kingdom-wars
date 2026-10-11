/** Complete VoyageLogic.kt presentation port. No clocks, requests, signing or game calculations.
 * The accepted web EMPTY-vehicle guard is preserved; all operation authority stays in the
 * original controllers and PanelSession. Static looks never authorize their own intents.
 */
import {PHASE_E_VEHICLES} from '@shardkeep/shared';
import type {CommandState,PriceUi,Verb} from '../craft/craftNativeModels';
import type {VehicleGate,RouteGate} from './voyageLogic';
import {orderTrips} from './voyageLogic';
export {vehicleCardState,defaultVehicle,islandTileState,orderTrips} from './voyageLogic';
export type VehicleFamily='STARTER'|'SURVEY_BALLOON'|'CARGO_CUTTER'|'COURIER_AIRSHIP'|'EXPEDITION_BARGE';
export type VehicleStatus='DOCKED'|'AWAY'|'WORN_OUT'|'EMPTY'|'BUSY_SERVICE';
export type TripState='AT_SEA'|'READY'|'COLLECTING'|'COLLECTED';
export interface VehicleUi extends VehicleGate {family:VehicleFamily;status:VehicleStatus;tier:number|null;berthId:string;tripsMax:number|null;returnsAt:string|null}
export interface RouteUi extends RouteGate {realmId:string;realmName:string;access:'HOME'|'PAID_REALM';myTrip:{tripId:string;state:TripState}|null;resourceIcon:string;resourceName:string}
export interface RewardUi {quantity:string;name:string}
export interface TripUi {tripId:string;state:TripState;secondsLeft:number|null;expected:readonly RewardUi[];returned:readonly RewardUi[]|null}
export interface PermitUi {price:PriceUi;realmName:string}
export interface PreviewUi {returnsAtLocal:string;supplies:readonly {name:string;short:boolean;shortLine?:string|null}[];permit:PermitUi|null}
export type RouteFilter='ALL'|'CAN_SAIL'|'HOME';
export type VoyageSealState='IDLE'|'ARMED'|'CHECK_WALLET'|'SENDING'|'SENT'|'ERROR';
export type ServiceOp='RESTORE_USES'|'UPGRADE';
export type VehicleCardState='SELECTED'|'ELIGIBLE'|'AWAY'|'TOO_LOW_TIER'|'COAST_ONLY'|'WORN_OUT'|'BUSY'|'EMPTY';
export interface PrimaryLook {label:string;sub:string|null;verb:Verb;state:CommandState;reason:string|null}
export interface FleetPrimary {action:'INSTALL'|'SEND_FROM_LODGE'|'SERVICE'|'CHECK'|'NONE';look:PrimaryLook|null}
export interface VoyageMoneyErrorUi {message:string;authoritative:boolean;recoverable?:boolean}
const names:Record<VehicleFamily,[string,string]>={STARTER:['Starter Boat','Starter'],SURVEY_BALLOON:['Survey Balloon','Balloon'],CARGO_CUTTER:['Cargo Cutter','Cutter'],COURIER_AIRSHIP:['Courier Airship','Airship'],EXPEDITION_BARGE:['Expedition Barge','Barge']};
export const familyName=(family:VehicleFamily)=>names[family][0];
export const familyShortName=(family:VehicleFamily)=>names[family][1];
export const vehicleTitle=(vehicle:VehicleUi)=>vehicle.family==='STARTER'?familyName(vehicle.family):`${familyName(vehicle.family)} ${tierTag(vehicle.tier)}`;
export const tierTag=(tier:number|null)=>`T${tier??'…'}`;
const gradeRoman:Readonly<Record<number,string>>={1:'I',2:'II',3:'III',4:'IV'};
export const gradeNumeral=(grade:number|null)=>grade===null?'…':gradeRoman[grade]??'…';
export const gradeRuleLine=(grade:number|null)=>grade===null||!PHASE_E_VEHICLES.tiers.some(tier=>tier===grade)?'Choose an island':`Grade ${gradeNumeral(grade)} needs Tier ${grade} or higher`;
export const tripsLeftShort=(left:number|null,max:number|null)=>`${left??'…'}/${max??'…'} left`;
export const tripsLeftLong=(left:number|null,max:number|null)=>`${left??'…'} of ${max??'…'} trips left`;
export const tripsFraction=(left:number|null,max:number|null)=>left===null||max===null||max<=0?null:Math.max(0,Math.min(1,left/max));
/** Native display warning thresholds; they change colour/badges only, never eligibility or uses. */
export const tripsMeterVerb=(left:number|null):Verb=>left!==null&&left<=2?'GOLD':'GREEN';
export const isWornOut=(vehicle:VehicleUi)=>vehicle.status==='WORN_OUT'||vehicle.tripsLeft===0;
export const canSelect=(state:string)=>state==='ELIGIBLE'||state==='SELECTED';
export function vehicleCardLine(vehicle:VehicleUi,state:VehicleCardState,grade:number|null):string {
  switch(state){
    case 'AWAY':return vehicle.returnsAt??'…';
    case 'TOO_LOW_TIER':return `Needs ${tierTag(grade)}`;
    case 'COAST_ONLY':return 'Coast only';
    case 'WORN_OUT':return 'Service';
    case 'BUSY':return 'In service';
    case 'EMPTY':return 'Install a vehicle at the Berth';
    default:return tripsLeftShort(vehicle.tripsLeft,vehicle.tripsMax);
  }
}
export const canSail=(route:RouteUi,bestTier:number|null)=>bestTier!==null&&route.grade<=bestTier;
export function filterRoutes(routes:readonly RouteUi[],filter:RouteFilter,bestTier:number|null):readonly RouteUi[] {
  return filter==='ALL'?routes:filter==='HOME'?routes.filter(route=>route.access==='HOME'):routes.filter(route=>canSail(route,bestTier));
}
export const filterCount=(routes:readonly RouteUi[],filter:RouteFilter,bestTier:number|null,loading:boolean)=>loading?'…':String(filterRoutes(routes,filter,bestTier).length);
export interface RealmBlock {realmId:string;realmName:string;resourceIcon:string;resourceName:string;access:'HOME'|'PAID_REALM';routes:RouteUi[]}
export function realmBlocks(routes:readonly RouteUi[],homeRealmId:string|null):RealmBlock[] {
  const groups=new Map<string,RouteUi[]>();
  for(const route of routes){const group=groups.get(route.realmId);if(group)group.push(route);else groups.set(route.realmId,[route]);}
  const blocks=[...groups].map(([realmId,group]):RealmBlock=>{const first=group[0]!;return {realmId,realmName:first.realmName,resourceIcon:first.resourceIcon,resourceName:first.resourceName,access:group.every(route=>route.access==='HOME')?'HOME':'PAID_REALM',routes:[...group].sort((a,b)=>a.grade-b.grade)};});
  const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
  return blocks.sort((a,b)=>(a.realmId===homeRealmId?0:1)-(b.realmId===homeRealmId?0:1)||compare(a.realmName.toLowerCase(),b.realmName.toLowerCase()));
}
export function gradeHeaderLine(grade:number,bestTier:number|null,awayTierReturn:Readonly<Record<number,string>>):[string,boolean] {
  if(bestTier!==null&&bestTier>=grade)return [`needs T${grade}+`,false];
  const away=Object.keys(awayTierReturn).map(Number).filter(tier=>tier>=grade).sort((a,b)=>a-b)[0];
  return away!==undefined?[`T${grade}+ in ${awayTierReturn[away]}`,true]:[`needs T${grade}+`,false];
}
export const tripsSummary=(trips:readonly TripUi[])=>`${trips.filter(trip=>trip.state==='AT_SEA').length} at sea · ${trips.filter(trip=>trip.state==='READY'||trip.state==='COLLECTING').length} back`;
export const tripsPrimary=(trips:readonly TripUi[],docked:readonly VehicleUi[])=>trips.some(trip=>trip.state==='READY'||trip.state==='COLLECTING')?'COLLECT':docked.some(vehicle=>vehicle.status==='DOCKED'&&!isWornOut(vehicle))?'SEND_ANOTHER':'NONE';
export function collectSubLine(trips:readonly TripUi[]):string {
  const ready=orderTrips(trips).filter(trip=>trip.state==='READY'||trip.state==='COLLECTING');
  if(ready.length!==1)return `${ready.length} trips back`;
  const first=ready[0]!,reward=(first.returned??first.expected)[0];
  return reward?`+${reward.quantity} ${reward.name}`.trimEnd():'1 trip back';
}
export function tripsTabBadge(trips:readonly TripUi[]):[string,boolean]|null {
  if(trips.some(trip=>trip.state==='READY'))return ['!',true];
  const atSea=trips.filter(trip=>trip.state==='AT_SEA').length;
  return atSea>0?[atSea>99?'99+':String(atSea),false]:null;
}
export interface SendLookInput {hasRoute:boolean;hasVehicle:boolean;previewState:'LOADING'|'READY'|'ERROR';preview:PreviewUi|null;ordersAllowed:boolean;ordersReason:string|null;lockedReason:string|null;busy:boolean;pending:boolean;previewError:string|null}
const look=(label:string,sub:string|null,verb:Verb,state:CommandState,reason:string|null):PrimaryLook=>({label,sub,verb,state,reason});
export function sendLook(ui:SendLookInput):PrimaryLook {
  const back=ui.preview?`back at ${ui.preview.returnsAtLocal}`:null,short=ui.preview?.supplies.find(supply=>supply.short),permit=ui.preview?.permit;
  if(ui.pending)return look('Checking departure',null,'STONE','BUSY',null);
  if(ui.lockedReason!==null)return look('SEND',null,'GOLD','LOCKED',ui.lockedReason);
  if(!ui.ordersAllowed)return look('SEND',null,'GOLD','DISABLED',ui.ordersReason??'This base is read-only');
  if(ui.busy)return look('Sending',null,'STONE','BUSY',null);
  if(!ui.hasRoute)return look('SEND',null,'GOLD','DISABLED','Choose an island first');
  if(!ui.hasVehicle)return look('SEND',null,'GOLD','DISABLED','Choose a vehicle that can sail there');
  if(ui.previewState==='LOADING')return look('Checking route',null,'STONE','BUSY',null);
  if(ui.previewState==='ERROR'||!ui.preview)return look('SEND',null,'GOLD','DISABLED',ui.previewError??"The Lodge can't reach the route chart. Try again.");
  if(short)return look('SEND',back,'GOLD','DISABLED',short.shortLine??`Need more ${short.name}`);
  return look('SEND',permit?`permit about ${permitAmount(permit)}`:back,'GOLD','ENABLED',null);
}
export const permitAmount=(permit:PermitUi)=>`${permit.price.amount?.trim()?permit.price.amount:'…'} SOL`;
export function fleetPrimary(selected:VehicleUi|null,pendingInstall:boolean,featureOffReason:string|null,walletLinked:boolean,ordersAllowed:boolean):FleetPrimary {
  if(!selected)return {action:'NONE',look:null};
  if(pendingInstall)return {action:'CHECK',look:look('CHECK','Installing · checking wallet','STONE','ENABLED',null)};
  if(selected.status==='EMPTY'){
    const label=`INSTALL ${familyShortName(selected.family).toUpperCase()}`;
    const state=featureOffReason!==null||!walletLinked?'LOCKED':!ordersAllowed?'DISABLED':'ENABLED';
    const reason=featureOffReason??(!walletLinked?'Link a wallet in Profile to install vehicles':!ordersAllowed?'This base is read-only':null);
    return {action:'INSTALL',look:look(label,state==='ENABLED'?'pick one from your wallet':null,'GOLD',state,reason)};
  }
  if(selected.status==='AWAY'||selected.status==='BUSY_SERVICE')return {action:'NONE',look:null};
  return isWornOut(selected)?{action:'SERVICE',look:look('SERVICE',null,'GOLD','ENABLED',null)}:{action:'SEND_FROM_LODGE',look:look('SEND FROM LODGE',null,'BLUE','ENABLED',null)};
}
export function berthRowLine(vehicle:VehicleUi):string {
  if(vehicle.status==='EMPTY')return vehicle.family==='STARTER'?'Empty · free to install':`Empty · flies to Grade ${gradeNumeral(Math.min(...PHASE_E_VEHICLES.tiers))}+`;
  if(vehicle.family==='STARTER')return vehicle.status==='AWAY'?'At sea · coast trips':'Coast trips · always free';
  if(vehicle.status==='AWAY')return `At sea · ${tripsLeftLong(vehicle.tripsLeft,vehicle.tripsMax)}`;
  return vehicle.status==='BUSY_SERVICE'?'In service · checking wallet':tripsLeftLong(vehicle.tripsLeft,vehicle.tripsMax);
}
export function berthRowTag(vehicle:VehicleUi):[string,Verb] {
  if(vehicle.status==='EMPTY')return ['EMPTY','STONE'];if(vehicle.status==='AWAY')return ['AWAY','BLUE'];if(vehicle.status==='BUSY_SERVICE')return ['BUSY','STONE'];
  return isWornOut(vehicle)?['SERVICE','RED']:['DOCKED','GREEN'];
}
export const serviceBadgeCount=(berths:readonly VehicleUi[])=>berths.filter(vehicle=>vehicle.family!=='STARTER'&&vehicle.status!=='EMPTY'&&vehicle.tripsLeft!==null&&vehicle.tripsLeft<=1).length;
export function servicePrimary(op:ServiceOp|null,optionAvailable:boolean,optionReason:string|null,resultTier:number|null,handInPresent:boolean,handInName:string,feeText:string|null,vehicleAway:boolean,awayLine:string|null):PrimaryLook|null {
  if(op===null)return null;
  const label=op==='RESTORE_USES'?'RESTORE TRIPS':`UPGRADE TO ${tierTag(resultTier)}`,sub=`network fee about ${feeText??'…'} SOL`;
  if(vehicleAway)return look(label,null,'GOLD','DISABLED',awayLine??'Service when it is docked');
  if(!optionAvailable)return look(label,null,'GOLD','LOCKED',optionReason??'Not available');
  return !handInPresent?look(label,sub,'GOLD','DISABLED',`You need a ${handInName} in your wallet`):look(label,sub,'GOLD','ENABLED',null);
}
export const moneyStage=(state:VoyageSealState)=>state==='IDLE'||state==='ARMED'?'READY':state==='ERROR'?'FAILED':state;
export const moneyError=(message:string,authoritative:boolean,recoverable=!authoritative)=>({message,authoritative,recoverable});
export const moneyErrorLine=(error:VoyageMoneyErrorUi)=>`${error.message.replace(/[. ]+$/,'')}. ${error.authoritative?'Nothing was sent.':'Your request is being checked.'}`;
/** Art geometry only: never gameplay quantities. Math.round matches Kotlin ties toward +Infinity. */
export const deviceArtScale=(designK:number,density:number)=>Math.max(1,Math.round(designK*density/2));
export const vehicleBbox=(family:VehicleFamily):readonly number[]=>({STARTER:[47,71,65,105],SURVEY_BALLOON:[36,34,76,110],CARGO_CUTTER:[36,52,77,108],COURIER_AIRSHIP:[21,52,94,102],EXPEDITION_BARGE:[28,66,85,105]})[family];
export const spriteOrigin=(windowW:number,windowH:number,scale:number,centreArtX:number,centreArtY:number,bottomArtY:number|null=null):[number,number]=>[Math.round(windowW/2-centreArtX*scale),bottomArtY===null?Math.round(windowH/2-centreArtY*scale):windowH-bottomArtY*scale];
export function dimMatrix(grey:number,brightness:number):number[] {
  const s=1-Math.min(1,Math.max(0,grey)),b=Math.max(0,brightness),lr=.2126,lg=.7152,lb=.0722;
  const row=(r:number,g:number,blue:number)=>[r*b,g*b,blue*b,0,0];
  return [...row(lr*(1-s)+s,lg*(1-s),lb*(1-s)),...row(lr*(1-s),lg*(1-s)+s,lb*(1-s)),...row(lr*(1-s),lg*(1-s),lb*(1-s)+s),0,0,0,1,0];
}
export function steppedRoutePoint(fromX:number,fromY:number,toX:number,toY:number,t:number):[number,number] {
  const mid=(fromX+toX)/2,a=Math.abs(mid-fromX),b=Math.abs(toY-fromY),c=Math.abs(toX-mid),total=a+b+c;
  if(total<=0)return [fromX,fromY];
  let d=Math.min(1,Math.max(0,t))*total;
  if(d<=a)return [fromX+(mid-fromX)*(a===0?0:d/a),fromY];d-=a;
  if(d<=b)return [mid,fromY+(toY-fromY)*(b===0?0:d/b)];d-=b;
  return [mid+(toX-mid)*(c===0?0:d/c),toY];
}
