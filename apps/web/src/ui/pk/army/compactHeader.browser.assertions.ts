/**
 * Authored before the sheets-v2 CSS delta for Beacon6419bdbb. UNRUN in this lane.
 * Cedar3 calls this against each real rendered sheet under the accepted PkSheetHost,
 * with a long title/status and enough body rows to scroll. This module neither opens
 * a browser nor supplies another host. happy-dom is not a geometry proof.
 */
export const compactHeaderCases = [
  {width:844,height:390,header:96,mode:'medium'},
  {width:915,height:311,header:60,mode:'compact'},
  {width:320,height:640,header:136,mode:'regular'},
] as const;
type Scenario = (typeof compactHeaderCases)[number];
const requireLayout = (ok:boolean,message:string) => { if(!ok) throw new Error(message); };
const overlaps = (a:DOMRect,b:DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
export function assertCompactHeaderLayout(sheet:HTMLElement, domain:'army'|'craft'|'voyage', scenario:Scenario):void {
  requireLayout(window.innerWidth===scenario.width && window.innerHeight===scenario.height,'Run at the exact admitted viewport');
  const outer=sheet.closest<HTMLElement>('.pk-sheethost');
  requireLayout(outer?.dataset['header']===scenario.mode,'The existing host must classify the header');
  const get=(part:string) => { const element=sheet.querySelector<HTMLElement>(`.pk-${domain}__${part}`); if(!element) throw new Error(`Missing ${domain} ${part}`); return element; };
  const header=get('header'), title=get('title'), tools=get('tools'), status=get('status'), scroll=get('scroll'), footer=get('footer');
  const rect=header.getBoundingClientRect();
  requireLayout(Math.abs(rect.height-scenario.header)<=0.5,'Header must consume the host height without flex shrink or a 136px floor');
  const toolButtons=[...tools.querySelectorAll<HTMLButtonElement>('button')];
  requireLayout(toolButtons.length>=1,'Close remains present');
  for(const button of toolButtons){const b=button.getBoundingClientRect();requireLayout(b.width>=48 && b.height>=48,'Header tools retain their 48px targets');requireLayout(b.top>=rect.top && b.bottom<=rect.bottom,'Header tools stay inside the header');}
  requireLayout(!overlaps(title.getBoundingClientRect(),status.getBoundingClientRect()),'Title and status must not overlap');
  requireLayout(!overlaps(title.getBoundingClientRect(),tools.getBoundingClientRect()),'Title must reserve the tool column');
  requireLayout(!overlaps(status.getBoundingClientRect(),tools.getBoundingClientRect()),'Status must reserve the compact tool column');
  requireLayout(scroll.clientHeight>0,'A positive body scroll region survives');
  requireLayout(scroll.scrollHeight>scroll.clientHeight,'Long fixture content scrolls rather than growing the panel');
  const panel=sheet.getBoundingClientRect(),foot=footer.getBoundingClientRect();
  requireLayout(foot.top>=panel.top && foot.bottom<=panel.bottom+0.5,'Footer stays pinned inside the sheet');
  requireLayout(sheet.scrollWidth<=sheet.clientWidth,'The 320px floor must not overflow horizontally');
  requireLayout(Boolean(sheet.getAttribute('aria-label')),'Full sheet title remains accessible when visually ellipsized');
}
