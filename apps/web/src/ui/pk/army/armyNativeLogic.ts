/** Complete ArmyLogic.kt presentation port. Original controllers own every
 * action and result; callers must receipt-gate settled loot before using looks.
 * No timers, requests, storage, local economy tables or effects live here.
 */
import {fmtDur} from '../../../lib/duration';
import type {HousingUi,CommandGate} from './armyLogic';
export {housingFractions,canAddTroop,trimDraft,commandTap,researchTap} from './armyLogic';
export type {HousingUi,DraftLine,CommandGate} from './armyLogic';
const grouped=(value:number|bigint)=>value.toLocaleString('en-US');
export const armyDuration=(seconds:number|null)=>seconds===null||!Number.isFinite(seconds)||seconds<0?'…':fmtDur(seconds);
export const housingCount=(h:HousingUi,showDraft=true)=>!h.known?{current:'…',draft:null,capacity:'…'}:{current:grouped(h.ready+h.training),draft:showDraft&&h.draft>0?`+${grouped(h.draft)}`:null,capacity:grouped(h.capacity)};
export function housingLegend(h:HousingUi,trainingDoneInSec:number|null=null,showDraft=true) {
 if(!h.known)return {ready:'… ready',training:'… training',draft:showDraft?'… chosen':null,fullNote:null};
 return {ready:`${grouped(h.ready)} ready`,training:`${grouped(h.training)} training${!showDraft&&h.training>0&&trainingDoneInSec!==null?` · in ${armyDuration(trainingDoneInSec)}`:''}`,draft:showDraft?`${grouped(h.draft)} chosen`:null,fullNote:h.full?'· full':null};
}
export const roomLeft=(h:HousingUi)=>h.known?Math.max(0,h.capacity-h.ready-h.training-h.draft):0;
export const effectiveState=(command:CommandGate)=>command.state!=='ENABLED'?command.state:command.price?.status==='UNAVAILABLE'?'DISABLED':command.price?.status==='SHORT'?'SHORT':'ENABLED';
export const troopTap=(state:string,sending:boolean)=>sending?'IGNORE':state==='DEFAULT'||state==='CHOSEN'?'ADD':state==='SHORT'?'NEED_MORE':state==='LOCKED'?'LOCKED':'NO_ROOM';
export function finishPrice<T extends {status:string;amount:string|null;description?:string|null}>(price:T,freeFinish:boolean):T {return freeFinish&&price.status==='SERVER_ZERO'?{...price,amount:'FREE',description:'Free finish'}:price;}
export interface ArmyBadgeUi {text:string;tone:'COUNT'|'REWARD';description:string}
export interface ArmyTabUi {id:string;icon:string;label:string;badge:ArmyBadgeUi|null;disabled:boolean}
export const ARMY_TAB_TRAIN='TRAIN',ARMY_TAB_ARMY='ARMY',HERO_TAB_HERO='HERO',HERO_TAB_SKILLS='SKILLS',HERO_TAB_GEAR='GEAR',RAID_TAB_MATCH='MATCH',RAID_TAB_CAMPAIGN='CAMPAIGN',RAID_TAB_REVENGE='REVENGE';
const tab=(id:string,icon:string,badge:ArmyBadgeUi|null=null):ArmyTabUi=>({id,icon,label:id,badge,disabled:false});
// Badge and pip caps are native visual budgets, not available troops or energy policy.
export const trainTabBadge=(queuedGroups:number,trainActive:boolean):ArmyBadgeUi|null=>trainActive||queuedGroups<=0?null:{text:queuedGroups>99?'99+':String(queuedGroups),tone:'COUNT',description:`${queuedGroups} training groups queued`};
export const armyTabs=(selected:string,queuedGroups:number,armyPortrait:string):ArmyTabUi[]=>[tab(ARMY_TAB_TRAIN,'ui_icon_warhorn',trainTabBadge(queuedGroups,selected===ARMY_TAB_TRAIN)),tab(ARMY_TAB_ARMY,armyPortrait)];
export const heroTabs=(heroPortrait:string,firstSkillIcon:string,gearNew:boolean):ArmyTabUi[]=>[tab(HERO_TAB_HERO,heroPortrait),tab(HERO_TAB_SKILLS,firstSkillIcon),tab(HERO_TAB_GEAR,'itm_helm',gearNew?{text:'NEW',tone:'REWARD',description:'New gear in your bag'}:null)];
export const raidTabs=(revengeCount:number):ArmyTabUi[]=>[tab(RAID_TAB_MATCH,'attack'),tab(RAID_TAB_CAMPAIGN,'star'),tab(RAID_TAB_REVENGE,'scout',revengeCount>0?{text:revengeCount>99?'99+':String(revengeCount),tone:'COUNT',description:`${revengeCount} raids to answer`}:null)];
export const defaultResearchSelection=(cards:readonly {troop:string;state:string}[])=>cards.find(card=>card.state==='DEFAULT'||card.state==='SELECTED')?.troop??null;
export interface ArmySkillUi {name:string;unlockLevel:number;unlocked:boolean}
export function skillSummary(skills:readonly ArmySkillUi[]):string {
 if(skills.length===0)return '…';const open=skills.filter(skill=>skill.unlocked).length,next=skills.filter(skill=>!skill.unlocked).sort((a,b)=>a.unlockLevel-b.unlockLevel)[0];
 return `${open} of ${skills.length}${next?` · new at Lv ${next.unlockLevel}`:''}`;
}
export const gearSummary=(worn:number,slots:number)=>slots<=0?'…':`${worn} of ${slots} worn`;
export const awakenMeter=(worn:number,slots:number,awakenAt:number)=>slots<=0?{fill:0,tick:null}:{fill:Math.min(1,Math.max(0,worn)/slots),tick:awakenAt>=1&&awakenAt<=slots?awakenAt/slots:null};
/** Native GEAR_SLOTS layout, not inventory policy. */
export const paperDoll=<T,>(slots:readonly T[])=>({left:slots.slice(0,4),right:slots.slice(4,8),bottom:slots.slice(8)});
export const healthLabel=(fraction:number|null,remainingSec:number|null)=>remainingSec!==null&&remainingSec>0?`back in ${armyDuration(remainingSec)}`:fraction!==null&&fraction>=1?'full':fraction===null?'…':'resting';
export const nextLevelLabel=(level:number,maxLevel:number)=>maxLevel>=1&&maxLevel<=level?'MAX':`LV ${level+1}`;
export function nextSkillLine(skill:ArmySkillUi|null,level:number,maxLevel:number):string|null {
 if(!skill||skill.unlocked||maxLevel>=1&&maxLevel<=level)return null;const left=Math.max(1,skill.unlockLevel-level);return `${skill.name} · ${left} ${left===1?'level':'levels'} to go`;
}
export const energyPips=(now:number|null,max:number|null,cap=10):boolean[]|null=>now===null||max===null||max<=0?null:Array.from({length:Math.min(max,cap)},(_,index)=>index<Math.max(0,Math.min(now,Math.min(max,cap))));
export const energyLine=(now:number|null,max:number|null,nextInSec:number|null)=>now===null||max===null?'…':now>=max?'full':nextInSec===null?'…':`+1 in ${armyDuration(nextInSec)}`;
export const readyOfCapacity=(ready:number|null,capacity:number|null)=>`${ready===null?'…':grouped(ready)}/${capacity===null?'…':grouped(capacity)}`;
export type DeltaTone='GAIN'|'LOSS'|'ZERO'|'UNKNOWN';
export function deltaTone(delta:string):DeltaTone {
 const text=delta.trim(),digits=text.replace(/^\+/,'').replace(/^-/,'').replace(/^−/,'').replaceAll(',','').replaceAll('.','');
 if(!/^\d+$/.test(digits))return 'UNKNOWN';if(/^0+$/.test(digits))return 'ZERO';return /^[-−]/.test(text)?'LOSS':'GAIN';
}
export const leadingTone=(label:string)=>deltaTone(label.trim().split(' ')[0]??'');
export const canSelectStage=(node:{state:string})=>node.state!=='LOCKED';
/** Exact integer digits, including values beyond Number.MAX_SAFE_INTEGER.
 * Progress is presentation-only; it cannot settle a result or publish a balance.
 */
export function countUpSigned(to:string,t:number):string {
 if(t>=1||!Number.isFinite(t))return to;const trimmed=to.trim(),sign=trimmed.match(/^[+−-]/)?.[0]??'',body=trimmed.slice(sign.length),isGrouped=/^\d{1,3}(,\d{3})+$/.test(body);
 if(!isGrouped&&!/^\d+$/.test(body))return to;const target=BigInt(body.replaceAll(',',''));if(target>(1n<<63n)-1n)return to;
 const [mantissa,exponent='0']=String(Math.max(0,Math.min(1,t))).split('e'),parts=mantissa!.split('.'),decimals=parts[1]?.length??0,power=Number(exponent)-decimals;
 const numerator=BigInt(parts.join(''))*(power>0?10n**BigInt(power):1n),denominator=power<0?10n**BigInt(-power):1n,value=target*numerator/denominator;
 return sign+(isGrouped?grouped(value):String(value));
}
export type ArmySettlement={kind:'PENDING'}|{kind:'REDACTED'}|{kind:'FAILED';message:string}|{kind:'SETTLED';loot:readonly {delta:string}[]};
/** Call only after same-operation receipt gating; a DTO shape is not verification. */
export const lootHint=(settlement:ArmySettlement)=>settlement.kind==='PENDING'?'Counting…':settlement.kind==='FAILED'?'still being settled':settlement.kind==='REDACTED'?null:settlement.loot.some(row=>deltaTone(row.delta)==='GAIN')?'sent to your storage':'nothing taken this time';
export type ArmySheetKind='TRAIN'|'ARMY'|'RESEARCH'|'HEROES'|'RAID'|'RESULT';
export function sheetResourceRows<T extends {accent:string;drawerHandle:boolean}>(all:readonly T[],kind:ArmySheetKind):T[] {
 const wanted=kind==='TRAIN'||kind==='RESEARCH'?['SHARDS','GEMS']:kind==='HEROES'?['GEMS']:['SHARDS'];return wanted.flatMap(accent=>{const row=all.find(value=>value.accent===accent);return row?[{...row,drawerHandle:false}]:[];});
}
// Native art geometry only. No animation clock or effect is installed by this port.
export const artDp=(artPx:number,scale:number)=>Math.max(1,artPx)*Math.max(1,scale)/2;
export const frameName=(stem:string,index:number,frames:number)=>frames<=1?stem:`${stem}_f${((index%frames)+frames)%frames+1}`;
export const headerFrame=(elapsedMs:number,fps:number,frames:number)=>frames<=1||fps<=0?0:Math.trunc(elapsedMs*fps/1000)%frames;
export const walkerVelocityDp=(dir:string)=>['W','SW','NW'].includes(dir)?-12:['E','NE','SE'].includes(dir)?12:0;
export function walkerX(startDp:number,velocityDp:number,elapsedMs:number,widthDp:number,spriteDp:number):number {
 if(velocityDp===0||widthDp<=0)return startDp;const span=widthDp+spriteDp,raw=startDp+spriteDp+velocityDp*elapsedMs/1000;return ((raw%span)+span)%span-spriteDp;
}
