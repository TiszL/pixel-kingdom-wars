import { CAMPAIGN, type CampaignTheme, type CampaignThreat } from '@shardkeep/shared';
import type { BaseVisualContext } from '@shardkeep/shared/baseVisual';
import presentation from './campaign-presentation.json';
export const FANTASY_CHAPTERS=presentation.chapters;
export const CAMPAIGN_REGION_MAPS=presentation.regions;
export interface CampaignStage {
 stage:number;act:number;tier:number;keepLevel:number;profile:'OUTPOST'|'BREACH'|'FORTRESS';
 name:string;theme:CampaignTheme;tactic:string;threat:CampaignThreat;position:{c:number;r:number};
 defenderHero:'vex'|'theodor'|null;recommendedArmyPoints:number;maxArmyPoints:number;
 bestStars:number;unlocked:boolean;firstThreeStarClaimed:boolean;
}
export interface CampaignPreview {
 stage:number;
 snapshot:{keepLevel:number;claimMin:number;claimMax:number;buildings:Array<{id:string;type:string;level:number;tx:number;ty:number}>};
 visualContext:BaseVisualContext;
}
export function chapterOf(stage:Pick<CampaignStage,'act'>){return FANTASY_CHAPTERS.find(c=>c.id===stage.act)??null;}
export function campaignPresentationName(stage:Pick<CampaignStage,'act'|'stage'|'name'>):string {
 return chapterOf(stage)?.names[(stage.stage-1)%CAMPAIGN.stagesPerAct]??stage.name;
}
export function campaignRoutePoint(stage:Pick<CampaignStage,'act'|'stage'>):{x:number;y:number}{
 const chapter=chapterOf(stage),region=chapter?CAMPAIGN_REGION_MAPS[chapter.region as keyof typeof CAMPAIGN_REGION_MAPS]:null;
 const point=region?.points[(stage.stage-1)%CAMPAIGN.stagesPerAct],crop=region?.crop;
 return point&&crop?{x:(point[0]!-crop[0]!)/crop[2]!,y:(point[1]!-crop[1]!)/crop[3]!}:{x:.5,y:.5};
}
export function campaignState(stage:Pick<CampaignStage,'bestStars'|'unlocked'>):'cleared'|'available'|'locked' {
 return stage.bestStars>0?'cleared':stage.unlocked?'available':'locked';
}
