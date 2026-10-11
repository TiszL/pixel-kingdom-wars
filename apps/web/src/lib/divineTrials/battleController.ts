import {PHASE_E_DIVINE_TRIALS as P} from '@shardkeep/shared';
import {isBattlefieldTileDeployable,occupiedBattlefieldTiles} from '@shardkeep/shared/battlefield';
import type {DivineTrialAttempt,DivineTrialOrders} from '@shardkeep/shared/divineTrialsApi';
import {footprintOf} from '../../game/fx/stats';
import {bus,type GameEvents} from '../events';
import {need,same,verifyAttempt} from './validation';
type Drop=DivineTrialOrders['deploys'][number];
export type DivineBattleState={ready:boolean;selected:keyof typeof P.army;deploys:Drop[];playing:boolean;displayed:boolean;error:string|null};
/** Presentation adapter only. No simulator, ordinary raid client or reward writer. */
export class DivineBattleController{
 private state:DivineBattleState={ready:false,selected:'highlander',deploys:[],playing:false,displayed:false,error:null};private listeners=new Set<()=>void>();private off:Array<()=>void>=[];private entered=false;private sawLoading=false;private played=false;private active=false;private sealed=false;private original:DivineTrialAttempt;
 constructor(raw:unknown,private current:()=>boolean){this.original=verifyAttempt(raw);}
 getSnapshot=()=>this.state;subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};private set(p:Partial<DivineBattleState>){this.state={...this.state,...p};this.listeners.forEach(fn=>fn());}
 start(){need(!this.active);this.active=true;this.off=[bus.on('scene:visual',v=>{if(!this.owns()||v.scene!=='battle')return;if(v.state==='loading'){this.sawLoading=true;this.set({ready:false});}else if(v.state==='ready'&&this.sawLoading){this.set({ready:true,error:null});this.play();}else if(v.state==='failed')this.set({ready:false,error:'Battle artwork is unavailable. Retry the scene or return home.'});}),bus.on('battle:tap',v=>this.tap(v)),bus.on('battle:done',()=>{if(this.owns()&&this.played&&this.original.result)this.set({playing:false,displayed:true});})];this.entered=true;const e=this.original.encounter;bus.emit('battle:enter',{snapshot:e.snapshot,armyLevels:e.levels,armyCounts:e.army,heroLevels:{}});}
 private owns(){return this.active&&this.entered&&this.current();}
 update(raw:unknown){const a=verifyAttempt(raw);need(a.id===this.original.id&&same(a.encounter,this.original.encounter));this.original=a;if(this.owns())this.play();}
 private play(){if(!this.owns()||!this.state.ready||this.played||!this.original.result)return;this.played=true;this.set({playing:true});bus.emit('battle:play',{events:this.original.result.events,simVersion:this.original.encounter.simVersion,terminal:true});}
 choose(troop:keyof typeof P.army){if(!this.owns()||this.sealed||this.original.orders)return;bus.emit('battle:holdCancel',undefined);this.set({selected:troop});}
 private tap(v:GameEvents['battle:tap']){if(!this.owns()||!this.state.ready||this.sealed||this.original.status!=='admitted'||this.original.orders||this.played)return;const troop=this.state.selected;if(this.state.deploys.filter(d=>d.troop===troop).length>=P.army[troop])return;const snapshot=this.original.encounter.snapshot,occupied=occupiedBattlefieldTiles(snapshot.buildings.map(b=>{const [fw,fh]=footprintOf(b.type);return {...b,fw,fh};}));if(!isBattlefieldTileDeployable(v.tx,v.ty,snapshot,occupied)||v.visibleTiles&&!v.visibleTiles.includes(`${v.tx},${v.ty}`)||v.previewVisible&&!v.previewVisible({tx:v.tx,ty:v.ty},troop))return;const drop={troop,tx:v.tx,ty:v.ty,tMs:P.deployTimeMs};this.set({deploys:[...this.state.deploys,drop]});bus.emit('battle:mark',drop);}
 undo(){if(!this.owns()||this.sealed||this.original.orders)return;const last=this.state.deploys.at(-1);if(!last)return;bus.emit('battle:holdCancel',undefined);bus.emit('battle:unmark',last);this.set({deploys:this.state.deploys.slice(0,-1)});}
 freeze(){need(this.owns()&&this.state.ready&&this.original.status==='admitted');const orders={deploys:structuredClone(this.state.deploys)};need(orders.deploys.length===P.maxDeploys,'Place the complete fixed army first.');this.sealed=true;bus.emit('battle:holdCancel',undefined);return orders;}
 stop(){const exit=this.owns();this.active=false;this.entered=false;for(const off of this.off.splice(0))off();if(exit)bus.emit('battle:exit',undefined);}
}
