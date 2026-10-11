import { useEffect, useMemo, useRef, useState } from 'react';
import { CAMPAIGN, RAID_RULES, WORLD } from '@shardkeep/shared';
import { api } from '../../lib/api';
import { bus } from '../../lib/events';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { useMobileBackHandler } from '../../lib/mobileBackGuard';
import { Icon } from '../primitives';
import { MAPCHROME, useWindowSize } from '../layout';
import { loadFantasyPixels } from './art';
import { fantasyPath,useFantasyRead } from './data';
import { CAMPAIGN_REGION_MAPS,FANTASY_CHAPTERS,campaignPresentationName,campaignRoutePoint,campaignState,chapterOf,type CampaignStage,type CampaignPreview } from './campaign';
import './world.css';
import './campaign.css';


export function FantasyCampaign():React.JSX.Element {
 const baseId=useApp(s=>s.selectedBaseId),wallet=useApp(s=>s.wallet),epoch=useApp(s=>s.baseSelectionEpoch);
 const setScreen=useApp(s=>s.setScreen),setMapTab=useApp(s=>s.setMapTab),setRaidTarget=useApp(s=>s.setRaidTarget),setScoutReport=useApp(s=>s.setScoutReport);
 const key=`${wallet}:${baseId}:${epoch}`;
 const size=useWindowSize(),flowLayout=size.w<=1000&&(size.h>480||size.w<600);
 const [detailsOpen,setDetailsOpen]=useState(true);
 const main=useRef<HTMLElement>(null),details=useRef<HTMLElement>(null),detailToggle=useRef<HTMLButtonElement>(null),inspectAfterRender=useRef(false);
 const board=useFantasyRead(wallet?`${key}:campaign`:null,()=>api.get<{stages:CampaignStage[]}>(fantasyPath('/campaign',baseId)),WORLD.mapPollSec*1000);
 const [selection,setSelection]=useState<{key:string;stage:number}>({key,stage:1});
 const [userSelected,setUserSelected]=useState(false),[previewBusy,setPreviewBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const stages=board.data?.stages??[],frontier=stages.find(s=>s.unlocked&&s.bestStars===0)??stages.at(-1);
 const selected=stages.find(s=>s.stage===(selection.key===key&&userSelected?selection.stage:frontier?.stage??1))??null;
 const chapter=selected?chapterOf(selected):FANTASY_CHAPTERS[0]!;
 const region=CAMPAIGN_REGION_MAPS[(chapter?.region??'crownlands') as keyof typeof CAMPAIGN_REGION_MAPS];
 const chapterStages=useMemo(()=>stages.filter(s=>s.act===chapter?.id),[stages,chapter?.id]);
 const cleared=stages.filter(s=>s.bestStars>0).length,totalStars=stages.reduce((total,s)=>total+s.bestStars,0);
 const canvas=useRef<HTMLCanvasElement>(null),source=useRef<HTMLCanvasElement|null>(null),chapterRail=useRef<HTMLDivElement>(null);
 const [artVersion,setArtVersion]=useState(0),[artError,setArtError]=useState(false);
 const pickStage=(stage:number,inspect=false):void=>{if(!stages.some(s=>s.stage===stage))return;inspectAfterRender.current=inspect&&flowLayout;setDetailsOpen(!flowLayout||inspect);setSelection({key,stage});setUserSelected(true);setError(null);};
 const returnToRoute=():void=>{setDetailsOpen(false);main.current?.scrollTo({top:0});};
 useEffect(()=>{
  if(!inspectAfterRender.current||!detailsOpen||!flowLayout)return;
  inspectAfterRender.current=false;
  const container=main.current,panel=details.current;if(!container||!panel)return;
  container.scrollTo({top:container.scrollTop+panel.getBoundingClientRect().top-container.getBoundingClientRect().top-8});
  detailToggle.current?.focus({preventScroll:true});
 },[selection,detailsOpen,flowLayout]);
 useMobileBackHandler(()=>{setScreen('base');return true;});
 useEffect(()=>{
  const abort=new AbortController();let alive=true;
  void loadFantasyPixels('realm-texture.png',abort.signal).then(pixels=>{
   if(!alive)return;
   const image=document.createElement('canvas');image.width=pixels.width;image.height=pixels.height;
   const ctx=image.getContext('2d');if(!ctx)throw Error('Campaign canvas unavailable');
   const data=ctx.createImageData(pixels.width,pixels.height);data.data.set(pixels.data);ctx.putImageData(data,0,0);source.current=image;setArtVersion(n=>n+1);
  }).catch(()=>{if(alive)setArtError(true);});
  return()=>{alive=false;abort.abort();source.current=null;};
 },[]);
 useEffect(()=>{
  const ctx=canvas.current?.getContext('2d');if(!ctx)return;
  ctx.imageSmoothingEnabled=false;ctx.fillStyle=region.ground;ctx.fillRect(0,0,640,520);
  if(source.current)ctx.drawImage(source.current,region.crop[0]!,region.crop[1]!,region.crop[2]!,region.crop[3]!,0,0,640,520);
  for(let i=1;i<chapterStages.length;i++){
   const previous=chapterStages[i-1]!,stage=chapterStages[i]!,a=campaignRoutePoint(previous),b=campaignRoutePoint(stage);
   const ax=a.x*640,ay=a.y*520,bx=b.x*640,by=b.y*520;
   ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash([]);ctx.strokeStyle='#222318bb';ctx.lineWidth=11;ctx.beginPath();ctx.moveTo(ax,ay);ctx.quadraticCurveTo((ax+bx)/2+(by-ay)*.14,(ay+by)/2-(bx-ax)*.14,bx,by);ctx.stroke();
   ctx.strokeStyle=stage.bestStars>0?'#efd18b':stage.unlocked?'#e4d2a6':'#aaa182';ctx.lineWidth=stage.bestStars>0?5:4;ctx.setLineDash(stage.bestStars>0?[]:[3,8]);ctx.stroke();ctx.setLineDash([]);
  }
 },[chapterStages,region,artVersion]);
 useEffect(()=>{
  const rail=chapterRail.current,node=rail?.querySelector<HTMLElement>(`[data-chapter="${chapter?.id}"]`);if(!rail||!node)return;
  const reveal=():void=>{const a=rail.getBoundingClientRect(),b=node.getBoundingClientRect();if(b.left<a.left)rail.scrollLeft+=b.left-a.left;else if(b.right>a.right)rail.scrollLeft+=b.right-a.right;if(getComputedStyle(rail).flexDirection==='column'){if(b.top<a.top)rail.scrollTop+=b.top-a.top;else if(b.bottom>a.bottom)rail.scrollTop+=b.bottom-a.bottom;}};
  reveal();window.addEventListener('resize',reveal);return()=>window.removeEventListener('resize',reveal);
 },[chapter?.id]);
 const enterBattle=():void=>{if(!selected?.unlocked)return;setRaidTarget({kind:'campaign',stage:selected.stage,name:`STAGE ${selected.stage} · ${campaignPresentationName(selected)}`});setScreen('battle');};
 const scout=async():Promise<void>=>{
  if(!selected?.unlocked||previewBusy)return;
  const stage=selected,guard=captureBaseSnapshotGuard();setPreviewBusy(true);setError(null);
  try{
   const data=await api.get<CampaignPreview>(fantasyPath(`/campaign/${stage.stage}/preview`,baseId));
   if(!isBaseSnapshotGuardCurrent(guard))return;
   if(data.stage!==stage.stage||data.snapshot.keepLevel!==stage.keepLevel)throw Error('Campaign preview mismatch');
   setScoutReport({name:`STAGE ${stage.stage} · ${campaignPresentationName(stage)}`,keepLevel:stage.keepLevel,trophies:0,previewSec:RAID_RULES.scoutPreviewSec,returnScreen:'map',
    attackTarget:{kind:'campaign',stage:stage.stage,name:`STAGE ${stage.stage} · ${campaignPresentationName(stage)}`}});
   setScreen('scout');bus.emit('battle:enter',{snapshot:data.snapshot,scout:true,visualContext:data.visualContext});
  }catch(cause){if(isBaseSnapshotGuardCurrent(guard))setError(cause instanceof Error?cause.message:'Stronghold preview unavailable');}finally{if(isBaseSnapshotGuardCurrent(guard))setPreviewBusy(false);}
 };
 return <div className="fantasy-world fantasy-campaign">
  <header className="fantasy-world-top" style={{height:MAPCHROME.bar,minHeight:MAPCHROME.bar}}><button onClick={()=>setScreen('base')}>‹ BASE</button><strong>THE FOUR REALM CAMPAIGN</strong><button onClick={()=>setMapTab('world')}>WORLD</button><button aria-pressed="true">CAMPAIGN</button></header>
  <div className="fantasy-campaign-summary"><span>{cleared}/{stages.length||CAMPAIGN.totalStages} CLEARED</span><span>{totalStars} ★</span><span>FREE · YOUR BASE IS NEVER AT RISK</span>{frontier&&<button onClick={()=>pickStage(frontier.stage)}>NEXT STAGE ›</button>}</div>
  <main className="fantasy-campaign-main" ref={main}><nav className="fantasy-chapter-rail" ref={chapterRail} aria-label="Campaign chapters">{FANTASY_CHAPTERS.map(c=><button key={c.id} data-chapter={c.id} aria-current={chapter?.id===c.id?'step':undefined} disabled={!stages.length} onClick={()=>{const first=stages.find(s=>s.act===c.id);if(first)pickStage(first.stage);}}><b>{String(c.id).padStart(2,'0')}</b><span>{c.name}<small>{CAMPAIGN_REGION_MAPS[c.region as keyof typeof CAMPAIGN_REGION_MAPS].name} · {stages.filter(s=>s.act===c.id&&s.bestStars>0).length}/{CAMPAIGN.stagesPerAct}</small></span></button>)}</nav>
   <section className="fantasy-campaign-expedition"><div className="fantasy-campaign-heading"><small>CHAPTER {chapter?.id} · {region.name}</small><h1>{chapter?.name}</h1><p>{chapter?.epithet}</p></div><div className="fantasy-route-map"><canvas ref={canvas} width={640} height={520} aria-label={`${region.name} campaign route`}/><div className="fantasy-route-nodes">{chapterStages.map(stage=>{const point=campaignRoutePoint(stage);return <button key={stage.stage} className={`fantasy-route-node ${campaignState(stage)} ${stage.threat}`} aria-label={`Stage ${stage.stage}: ${campaignPresentationName(stage)}, ${campaignState(stage)}`} aria-pressed={selected?.stage===stage.stage} style={{left:`${point.x*100}%`,top:`${point.y*100}%`}} onClick={()=>pickStage(stage.stage,true)}><span>{stage.stage}</span>{stage.threat!=='standard'&&<small>{stage.threat==='boss'?'BOSS':'ELITE'}</small>}</button>;})}</div><div className="fantasy-route-landmark">{chapter?.landmark}</div></div>
   <nav className="fantasy-stage-strip" aria-label="Stages in this chapter">{chapterStages.map(stage=><button key={stage.stage} aria-pressed={selected?.stage===stage.stage} aria-label={`Stage ${stage.stage}: ${campaignPresentationName(stage)}`} onClick={()=>pickStage(stage.stage,true)}>{stage.stage}<small>{'★'.repeat(stage.bestStars)||'·'}</small></button>)}</nav>
   <p className="fantasy-campaign-lore">{chapter?.lore}</p>{artError&&<p role="status">Couldn’t load the map. You can still choose a stage.</p>}
   </section><aside className="fantasy-campaign-details" ref={details} aria-label="Selected campaign stage"><button className="fantasy-campaign-detail-toggle" ref={detailToggle} aria-expanded={detailsOpen} aria-controls="fantasy-campaign-stage-details" onClick={()=>setDetailsOpen(open=>!open)}><span>{selected?`STAGE ${selected.stage} · ${campaignPresentationName(selected)}`:'STAGE DETAILS'}</span><span aria-hidden="true">{detailsOpen?'−':'+'}</span></button><div id="fantasy-campaign-stage-details" className="fantasy-panel-content" hidden={!detailsOpen}><div data-onboarding-caption-slot="campaign"/>{board.pending&&<p role="status">Reading campaign progress…</p>}{board.error&&<p role="alert">{board.error.message} <button onClick={board.retry}>RETRY</button></p>}{selected&&<><small className="fantasy-kicker">STAGE {String(selected.stage).padStart(3,'0')} · {selected.threat==='standard'?selected.profile:selected.threat.replace('_',' ')}</small><h1>{campaignPresentationName(selected)}</h1><div className={`fantasy-campaign-state ${campaignState(selected)}`}>{campaignState(selected).toUpperCase()} <span>{'★'.repeat(selected.bestStars)}{'☆'.repeat(3-selected.bestStars)}</span></div><p>{selected.tactic}</p><dl className="fantasy-campaign-stats"><div><dt>KEEP LEVEL</dt><dd>{selected.keepLevel}</dd></div><div><dt>RECOMMENDED ARMY</dt><dd>{selected.recommendedArmyPoints} pts</dd></div><div><dt>ARMY CAPACITY</dt><dd>{selected.maxArmyPoints} pts</dd></div><div><dt>GARRISON</dt><dd>{selected.defenderHero?.toUpperCase()??'—'}</dd></div></dl><div className="fantasy-reward"><Icon name="shard" size={24}/><span>{(CAMPAIGN.firstThreeStarShardsByKeep[selected.keepLevel-1]??0).toLocaleString()} SHARDS<small>{selected.firstThreeStarClaimed?'CLAIMED':'FIRST 3★ · ONE TIME'}</small></span></div>
   {selected.unlocked?<><button onClick={()=>void scout()} disabled={previewBusy} className="fantasy-scout">{previewBusy?'READING STRONGHOLD…':'SCOUT STRONGHOLD'}</button><div data-tutorial-target="campaign-attack"><button className="fantasy-primary" onClick={enterBattle}>{selected.bestStars>0?'REPLAY STAGE':'ATTACK'}</button></div><p className="fantasy-muted">{selected.firstThreeStarClaimed?'Stars can still be improved. The first 3★ reward has already been claimed.':'Retries are free. The first 3★ victory awards the reward once.'}</p></>:<><p>Clear stage {selected.stage-1} to open this road.</p><button onClick={()=>pickStage(selected.stage-1)}>‹ PREVIOUS STAGE</button></>}{error&&<p role="alert">{error}</p>}</>}<button className="fantasy-campaign-back-route" onClick={returnToRoute}>↑ BACK TO ROUTE</button></div></aside>
  </main>
 </div>;
}
