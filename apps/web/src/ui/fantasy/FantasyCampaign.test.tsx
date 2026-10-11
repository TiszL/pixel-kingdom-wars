/** @vitest-environment happy-dom */
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAMPAIGN } from '@shardkeep/shared';
import { unsupportedGroundRevision } from '@shardkeep/shared/baseVisual';
import { useApp } from '../../state/store';
import { api } from '../../lib/api';
import { bus } from '../../lib/events';
import type { CampaignStage } from './campaign';
const campaignCss=readFileSync('src/ui/fantasy/campaign.css','utf8');
const model=vi.hoisted(()=>({w:575,h:1280,stages:[] as CampaignStage[]}));
vi.mock('../layout',async original=>({...await original<typeof import('../layout')>(),useWindowSize:()=>({w:model.w,h:model.h})}));
vi.mock('./data',async original=>({...await original<typeof import('./data')>(),useFantasyRead:()=>({data:{stages:model.stages},pending:false,error:null,retry:vi.fn()})}));
vi.mock('./art',()=>({loadFantasyPixels:()=>new Promise(()=>{})}));
vi.mock('../../lib/mobileBackGuard',()=>({useMobileBackHandler:vi.fn()}));
import { FantasyCampaign } from './FantasyCampaign';
let host:HTMLDivElement,root:Root,style:HTMLStyleElement;
const button=(selector:string)=>host.querySelector<HTMLButtonElement>(selector)!;
beforeEach(()=>{
 (globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 model.w=575;model.h=1280;
 model.stages=CAMPAIGN.encounters.map(e=>({stage:e.stage,act:Math.ceil(e.stage/CAMPAIGN.stagesPerAct),tier:e.keepLevel,keepLevel:e.keepLevel,name:e.name,theme:e.theme,tactic:e.tactic,profile:e.profile,threat:e.threat,position:{c:e.c,r:e.r},defenderHero:null,recommendedArmyPoints:CAMPAIGN.recommendedArmyPointsByKeep[e.keepLevel-1]!,maxArmyPoints:20,bestStars:0,unlocked:e.stage===1,firstThreeStarClaimed:false}));
 useApp.setState({wallet:'campaign-owner',authed:true,screen:'map',mapTab:'campaign',selectedBaseId:'campaign-base',baseSelectionEpoch:0});
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
 style=document.createElement('style');style.textContent='.fantasy-world-panel{position:absolute;inset:0}'+campaignCss;document.head.append(style);
 const context={fillRect:vi.fn(),drawImage:vi.fn(),setLineDash:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),quadraticCurveTo:vi.fn(),stroke:vi.fn()};
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(context as never);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();style.remove();vi.restoreAllMocks();});
const mount=()=>act(async()=>root.render(<FantasyCampaign/>));
describe('campaign responsive stage inspection',()=>{
 it.each([[575,1280],[390,844],[844,390],[1440,900]])('keeps chapter, route and stage detail in separate layout regions at %i×%i',async(w,h)=>{
  model.w=w;model.h=h;await mount();
  const main=host.querySelector('main')!,rail=host.querySelector('[aria-label="Campaign chapters"]')!,map=host.querySelector('.fantasy-campaign-expedition')!,detail=host.querySelector('.fantasy-campaign-details')!;
  expect([...main.children]).toEqual([rail,map,detail]);
  expect(detail.classList.contains('fantasy-world-panel')).toBe(false);
  expect(getComputedStyle(detail).position).toBe('relative');
  expect(rail.querySelectorAll('button')).toHaveLength(10);
  expect(map.querySelectorAll('.fantasy-route-node')).toHaveLength(10);
  expect(host.querySelector('.fantasy-campaign-summary')?.getAttribute('style')).toBeNull();
 });
 it('phone stage selection reveals inline details and returns to the route without scrolling the document',async()=>{
  await mount();const main=host.querySelector('main')!,detail=host.querySelector('.fantasy-campaign-details')!;
  const scroll=vi.spyOn(main,'scrollTo'),pageScroll=vi.spyOn(window,'scrollTo');
  vi.spyOn(main,'getBoundingClientRect').mockReturnValue(new DOMRect(0,100,575,1180));
  vi.spyOn(detail,'getBoundingClientRect').mockReturnValue(new DOMRect(12,850,551,450));
  await act(async()=>button('.fantasy-route-node:nth-child(2)').click());
  expect(button('.fantasy-campaign-detail-toggle').getAttribute('aria-expanded')).toBe('true');
  expect(button('.fantasy-campaign-detail-toggle').textContent).toContain('STAGE 2');
  expect(scroll).toHaveBeenLastCalledWith({top:742});
  expect(document.activeElement).toBe(button('.fantasy-campaign-detail-toggle'));
  expect(pageScroll).not.toHaveBeenCalled();
  expect(host.querySelector('[data-tutorial-target="campaign-attack"]')).toBeNull();
  expect(host.querySelector('#fantasy-campaign-stage-details')?.textContent).toContain('Clear stage 1');
  await act(async()=>button('.fantasy-campaign-back-route').click());
  expect(button('.fantasy-campaign-detail-toggle').getAttribute('aria-expanded')).toBe('false');
  expect((host.querySelector('#fantasy-campaign-stage-details') as HTMLElement).hidden).toBe(true);
  expect(scroll).toHaveBeenLastCalledWith({top:0});
 });
 it('short landscape keeps independently scrollable columns without jumping the whole board',async()=>{
  model.w=844;model.h=390;await mount();
  const scroll=vi.spyOn(host.querySelector('main')!,'scrollTo');
  await act(async()=>button('.fantasy-route-node:nth-child(3)').click());
  expect(scroll).not.toHaveBeenCalled();
  expect(button('.fantasy-campaign-detail-toggle').textContent).toContain('STAGE 3');
 });
 it('chapter selection preserves all stage identities and server progress without granting access',async()=>{
  model.stages[0]={...model.stages[0]!,bestStars:3,firstThreeStarClaimed:true};
  model.stages[1]={...model.stages[1]!,unlocked:true};
  const original=JSON.stringify(model.stages);await mount();
  for(let chapter=1;chapter<=10;chapter++){
   await act(async()=>button(`[data-chapter="${chapter}"]`).click());
   const ids=[...host.querySelectorAll('.fantasy-route-node>span')].map(n=>Number(n.textContent));
   expect(ids).toEqual(Array.from({length:10},(_,i)=>(chapter-1)*10+i+1));
  }
  expect(JSON.stringify(model.stages)).toBe(original);
  expect(host.querySelector('[data-tutorial-target="campaign-attack"]')).toBeNull();
 });
 it('scouts the selected server stage with defender visual context and attacks its unchanged ID',async()=>{
  const context={version:1,realmId:'crownlands',artVersion:2} as const;
  vi.spyOn(api,'get').mockResolvedValue({stage:1,snapshot:{keepLevel:1,buildings:[]},visualContext:context});
  const emit=vi.spyOn(bus,'emit');await mount();
  await act(async()=>button('.fantasy-scout').click());
  expect(api.get).toHaveBeenCalledWith('/campaign/1/preview?baseId=campaign-base');
  expect(emit).toHaveBeenCalledWith('battle:enter',expect.objectContaining({scout:true,visualContext:context}));
  await act(async()=>button('[data-tutorial-target="campaign-attack"] button').click());
  expect(useApp.getState().raidTarget).toMatchObject({kind:'campaign',stage:1});
  expect(model.stages[0]).toMatchObject({bestStars:0,firstThreeStarClaimed:false});
 });
 it('hands a newer ground revision to the scene unresolved, so the reload prompt still fires',async()=>{
  // WHY: SceneGround.set is the one detector for art newer than this bundle. Resolving the preview
  // context here first dropped revision 6 to the frozen fallback: a stale tab scouting a campaign
  // stronghold painted old ground and never asked for a reload.
  const context={version:1,realmId:'crownlands',artVersion:2,groundRevision:6};
  vi.spyOn(api,'get').mockResolvedValue({stage:1,snapshot:{keepLevel:1,buildings:[]},visualContext:context});
  const emit=vi.spyOn(bus,'emit');await mount();
  await act(async()=>button('.fantasy-scout').click());
  const enter=emit.mock.calls.find(([event])=>event==='battle:enter');
  expect(enter?.[1]).toMatchObject({scout:true,visualContext:context});
  expect(unsupportedGroundRevision((enter?.[1] as {visualContext?:unknown}).visualContext)).toBe(6);
 });
});
