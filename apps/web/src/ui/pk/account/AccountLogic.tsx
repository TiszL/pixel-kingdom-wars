/** Presentation-only parity rules from Android AccountLogic.kt at 2ca25382.
 * Costs, limits, capabilities and reward amounts are caller-supplied server/constants data.
 * These rules route to review/recovery; they never authorize or send a transaction. */
import type { CommandState, PriceUi, Verb, SealUi } from '../types';
export interface PrimaryLook { label: string; sub: string | null; state: CommandState; reason: string | null; verb: Verb }
export const unknown = (s: string | null | undefined) => s?.trim() || '…';
export function primaryTap(look: Pick<PrimaryLook,'state'|'reason'>) {
 return look.state === 'ENABLED' ? 'ACT' : look.state === 'SHORT' ? 'NEED_MORE' : (look.state === 'LOCKED' || look.state === 'DISABLED') && look.reason ? 'EXPLAIN' : 'IGNORE';
}
export function shortAddress(address: string | null, head = 4, tail = 4) { const a=address?.trim(); return !a ? '…' : a.length <= head+tail+1 ? a : a.slice(0,head)+'…'+a.slice(-tail); }
export function priceLabel(p: PriceUi) { return p.status==='SERVER_ZERO' ? 'FREE' : p.status==='CHECKING' ? '…' : p.status==='UNAVAILABLE' ? 'unavailable' : unknown(p.amount); }
const look = (label:string,state:CommandState='ENABLED',reason:string|null=null,sub:string|null=null):PrimaryLook => ({label,state,reason,sub,verb:'GOLD'});
export function landGatePrimary(walletLinked:boolean,alreadyOwned:boolean,off:string|null) { return off ? look('CHOOSE REALM','LOCKED',off) : alreadyOwned ? look('CHOOSE REALM','LOCKED','One land per wallet. This wallet has its land.') : !walletLinked ? look('CONNECT WALLET','ENABLED',null,'Land is paid from a wallet') : look('CHOOSE REALM'); }
export function settleLook(realm:string|null,lock:'NONE'|'FULL'|'SKR_UNLOCK'|null,p:PriceUi):PrimaryLook {
 const label=realm ? `SETTLE IN ${realm.toUpperCase()}` : 'SETTLE'; const sub=p.status==='UNAVAILABLE' ? 'Land price unavailable right now' : `${priceLabel(p)} SOL · one land per wallet`;
 return !realm ? look(label,'DISABLED','Pick a realm first') : lock==='FULL' ? look(label,'DISABLED',`${realm} is full right now`,sub) : lock==='SKR_UNLOCK' ? look(label,'LOCKED','Seeker tiles open with SKR',sub) : p.status==='UNAVAILABLE' ? look(label,'DISABLED','Land price unavailable right now') : p.status==='SHORT' ? look(label,'SHORT','Not enough SOL',sub) : look(label,'ENABLED',null,sub);
}
export function addKingdomSub(p:PriceUi) { return p.status==='SERVER_ZERO' ? 'Your second land is free' : p.status==='UNAVAILABLE' ? 'Land price unavailable right now' : `Another land: ${priceLabel(p)} SOL`; }
export function landPaymentLine(outcome:'IN_FLIGHT'|'CHECKING'|'REFUSED',reason:string|null=null) { const refusal=reason?.trim()||'The land purchase was refused.';return outcome==='IN_FLIGHT' ? null : outcome==='CHECKING' ? 'We are checking your payment. Your land is safe if it went through.' : `${refusal}${/[.!?]$/.test(refusal)?'':'.'} Nothing was spent.`; }
export function historyLine(needs:number|null,done:number|null) {const d=`${done??'…'} done`;return needs===null?`… need you · ${d}`:needs>0?`${needs} need you · ${d}`:d;}
export function kingdomsMode(landless:boolean,count:number) {return landless||count===0?'LANDLESS':count===1?'ONE':'MANY';}
export function canUnlink(linked:Record<string,boolean>,kind:string) {return linked[kind]===true&&Object.values(linked).filter(Boolean).length>1;}
export function nameSaveEnabled(draft:string,saved:string,saving:boolean){return !saving&&draft.trim().length>0&&draft.trim()!==saved.trim();}
export type ClanRole='LEADER'|'ELDER'|'MEMBER';
export function memberPowers(role:ClanRole,target:{role:ClanRole;isYou:boolean}) {return {canPromote:!target.isYou&&(role==='LEADER'?target.role!=='LEADER':role==='ELDER'&&target.role==='MEMBER'),canKick:!target.isYou&&role==='LEADER'&&target.role!=='LEADER'};}
export function sortMembers<T extends {trophies:number|null;wins:number|null;online:boolean}>(rows:T[],sort:'TROPHIES'|'WINS'|'ONLINE'):T[] {const desc=(a:number|null,b:number|null)=>a===null?(b===null?0:1):b===null?-1:b-a;return [...rows].sort((a,b)=>sort==='WINS'?desc(a.wins,b.wins):sort==='ONLINE'?Number(b.online)-Number(a.online)||desc(a.trophies,b.trophies):desc(a.trophies,b.trophies));}
export interface FaucetState {state:'HIDDEN'|'NEEDS_DEED'|'READY'|'CLAIMING'|'CLAIMED'|'UNAVAILABLE'|'CHECKING';amount:string|null;nextIn?:string|null;reason?:string|null}
export function faucetLook(ui:FaucetState) {
 if(ui.state==='HIDDEN')return null;
 if(ui.state==='CHECKING')return {headline:'Daily test SKR',line:'We are checking your claim. Your SKR is safe if it went through.',button:'RECHECK' as const};
 if(ui.state==='NEEDS_DEED')return {headline:`${unknown(ui.amount)} SKR a day`,line:'Needs a Kingdom Deed. Buy land once, then claim every day.',button:'GET_LAND' as const};
 if(ui.state==='CLAIMED')return {headline:'Claimed',line:`Claimed · next in ${unknown(ui.nextIn)}`,button:'NONE' as const};
 if(ui.state==='UNAVAILABLE')return {headline:'Daily test SKR',line:unknown(ui.reason),button:'NONE' as const};
 return {headline:`+${unknown(ui.amount)} SKR`,line:'Free once a day for deed holders. Test SKR, no real value.',button:ui.state==='CLAIMING'?'BUSY' as const:'CLAIM' as const};
}
export function titleConnectLabel(last:string|null){return last?.trim()?`CONTINUE AS ${last}`:'CONNECT WALLET';}
export function titleConnectStage(busy:'WALLET_CHECK'|'WALLET_SENDING'|'SOCIAL'|null){return busy==='WALLET_CHECK'?'CHECK_WALLET':busy==='WALLET_SENDING'?'SENDING':'READY';}

/** Security protocol width, not game/economy policy. Only ASCII TOTP digits survive. */
export const TOTP_CELLS = 6;
export function totpDraft(raw: string, cells = TOTP_CELLS): string {
 return raw.replace(/[^0-9]/g, '').slice(0, Math.max(0, cells));
}
/** Presentation for the existing host's Seal. Creating this model never arms or submits a payment. */
export function landSealUi(realm: string, price: PriceUi, armedAtMs: number): SealUi {
 return { title: `BUY LAND IN ${realm.toUpperCase()}?`, lines: [
  'Paid from your wallet. You sign once.', `Your base gets a tile in ${realm} and a deed you own.`,
  'One land per wallet. The network fee is shown in your wallet.',
 ], price, confirmLabel: 'BUY LAND', armedAtMs,
 gets: { currency: 'ITEM', amount: 'DEED', status: 'OK', icon: 'itm_deed_earth', description: 'Kingdom Deed' } };
}
/** Session cap must come from an accepted policy; absent policy does not invent a cap. */
export function landHeraldShown(landless: boolean, sessionNumber: number, maxSessions: number | null): boolean {
 return landless && maxSessions !== null && Number.isInteger(sessionNumber) && sessionNumber >= 1 && sessionNumber <= maxSessions;
}
export function coachPlateTop(targetTop: number, targetBottom: number, plateHeight: number, areaHeight: number, gap: number): number {
 const below = targetBottom + gap;
 return below + plateHeight <= areaHeight ? below : Math.max(0, targetTop - gap - plateHeight);
}
export function providerLetter(provider: 'WALLET' | 'GOOGLE' | 'X' | 'EMAIL'): string {
 return { WALLET: '', GOOGLE: 'G', X: 'X', EMAIL: '@' }[provider];
}
/** Daily test SKR row. This is never a mapping of the distinct devnet SOL faucet. */
export function faucetRowLine(ui: FaucetState): string | null {
 switch (ui.state) {
  case 'HIDDEN': return null;
  case 'NEEDS_DEED': return 'Needs a Kingdom Deed';
  case 'READY': return `+${unknown(ui.amount)} ready today`;
  case 'CLAIMING': return `+${unknown(ui.amount)} on its way`;
  case 'CLAIMED': return `Claimed · next in ${unknown(ui.nextIn)}`;
  case 'UNAVAILABLE': return unknown(ui.reason);
  case 'CHECKING': return 'Checking your claim';
 }
}
export function stackedTabScrollTarget(widths: readonly number[], gap: number, active: number, viewport: number, peek: number, current = 0): number {
 if (!widths.length || viewport <= 0) return 0;
 const i = Math.max(0, Math.min(widths.length - 1, active));
 const total = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
 const max = Math.max(0, total - viewport);
 const start = widths.slice(0, i).reduce((sum, width) => sum + width, 0) + gap * i;
 const end = start + widths[i]!;
 const wanted = i < widths.length - 1 ? end + gap + peek : end;
 let target = Math.max(0, Math.min(max, current));
 if (wanted > target + viewport) target = wanted - viewport;
 if (start < target) target = start;
 return Math.max(0, Math.min(max, target));
}
/** Native strip layout metrics; these are design dimensions, not game values. */
export function scrollingTabWidthDp(label: string): number { return Math.max(72, label.length * 10 + 26); }
export function supplyBuyLook(label: string | null, sub: string | null, price: PriceUi | null, lockedReason: string | null): PrimaryLook {
 return label === null || price === null ? look('BUY', 'DISABLED', 'Pick a supply first')
  : lockedReason !== null ? look(label, 'LOCKED', lockedReason)
  : price.status === 'UNAVAILABLE' ? look(label, 'DISABLED', 'Price unavailable right now')
  : price.status === 'SHORT' ? look(label, 'SHORT', 'Not enough to buy this', sub) : look(label, 'ENABLED', null, sub);
}
/** Pass shared CLANS from the host. Native fixture limits differ from current server policy. */
export interface ClanTextRules { nameMinLen: number; nameMaxLen: number; tagMinLen: number; tagMaxLen: number }
export function clanNameError(name: string, rules: ClanTextRules): string | null {
 const value = name.trim();
 return !value ? null : value.length < rules.nameMinLen || value.length > rules.nameMaxLen
  ? `${rules.nameMinLen} to ${rules.nameMaxLen} letters`
  : !/^[A-Za-z0-9 ._-]+$/.test(value) ? 'ASCII letters, numbers, spaces, . _ and - only' : null;
}
export function clanTagError(tag: string, rules: ClanTextRules): string | null {
 const value = tag.trim().toUpperCase();
 return !value ? null : value.length < rules.tagMinLen || value.length > rules.tagMaxLen
  ? `${rules.tagMinLen} ${rules.tagMaxLen === rules.tagMinLen + 1 ? 'or' : 'to'} ${rules.tagMaxLen} letters`
  : !/^[A-Z0-9]+$/.test(value) ? 'ASCII letters and numbers only' : null;
}
export function clanTagDraft(raw: string, rules: ClanTextRules): string {
 return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, rules.tagMaxLen);
}
export function stepMinTrophies(value: number, delta: number, step: number, min: number, max: number): number {
 return Math.max(min, Math.min(Math.max(min, max), value + delta * step));
}
export function clanCreateLook(hallLockedReason: string | null, name: string, tag: string, price: PriceUi | null, rules: ClanTextRules): PrimaryLook {
 const ready = !!name.trim() && !!tag.trim() && clanNameError(name, rules) === null && clanTagError(tag, rules) === null;
 return hallLockedReason !== null ? look('CREATE CLAN', 'LOCKED', hallLockedReason)
  : !ready ? look('CREATE CLAN', 'DISABLED', 'Give the clan a name and a tag')
  : price?.status === 'UNAVAILABLE' ? look('CREATE CLAN', 'DISABLED', 'Price unavailable right now')
  : price?.status === 'SHORT' ? look('CREATE CLAN', 'SHORT', `Not enough ${price.currency}`) : look('CREATE CLAN');
}
export type TourneyPhase = 'ENTRY' | 'BATTLES' | 'RESULTS' | 'CLOSED';
export type StepTone = 'DONE' | 'CURRENT' | 'TODO';
export function tourneySteps(phase: TourneyPhase, entered: boolean): StepTone[] {
 switch (phase) {
  case 'ENTRY': return entered ? ['DONE', 'CURRENT', 'TODO'] : ['CURRENT', 'TODO', 'TODO'];
  case 'BATTLES': return ['DONE', 'CURRENT', 'TODO'];
  case 'RESULTS': return ['DONE', 'DONE', 'CURRENT'];
  case 'CLOSED': return ['DONE', 'DONE', 'DONE'];
 }
}
/** Display rules only; the host's live roster/capability and claim controller still gate each intent. */
export function tourneyLook(phase: TourneyPhase, entered: boolean, amCaptain: boolean, inRoster: boolean, fightsUsed: number | null,
 fightsMax: number | null, opensIn: string | null, prizeClaimable: boolean): PrimaryLook {
 const fight = (state: CommandState, reason: string | null): PrimaryLook => ({ label: 'FIND MATCH', sub: null, verb: 'RED', state, reason });
 return prizeClaimable ? look('CLAIM PRIZE')
  : phase === 'CLOSED' ? fight('LOCKED', 'This tournament is over')
  : !entered && phase === 'ENTRY' && amCaptain ? look('ENTER CLAN', 'ENABLED', null, 'As clan captain')
  : !entered ? fight('LOCKED', phase === 'ENTRY' ? 'Your captain enters the clan' : 'Your clan is not in this tournament')
  : !inRoster ? fight('LOCKED', 'You joined after the roster locked')
  : phase === 'ENTRY' ? fight('LOCKED', opensIn ?? 'Battles open soon')
  : phase === 'RESULTS' ? fight('LOCKED', 'Battles are over. See the rankings.')
  : fightsUsed !== null && fightsMax !== null && fightsUsed >= fightsMax ? fight('DISABLED', `You used all ${fightsMax} fights`)
  : fight('ENABLED', null);
}
export function charterToolsLock(amCaptain: boolean, pausedReason: string | null): string | null {
 return pausedReason ?? (amCaptain ? null : 'captain');
}
