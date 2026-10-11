/** CraftLogic/CraftR2Logic presentation boundary. No cost tables, wall clock or collection transport. */
import { hasReceipt } from './receiptEvidence';
export function ingredientState(have: number | bigint | null, need: number | bigint) {
  const difference = have === null ? null : typeof have === 'bigint' || typeof need === 'bigint' ? BigInt(need) - BigInt(have) : need - have;
  const missing = difference === null ? null : typeof difference === 'bigint' ? difference > 0n ? difference : 0n : Math.max(0, difference);
  return {count:`${have === null ? '…' : have.toLocaleString('en-US')}/${need.toLocaleString('en-US')}`,missing,ok:missing === 0 || missing === 0n,short:missing !== null && missing > 0};
}
export function stepQuantity(current: number, delta: number, min: number, max: number) {
  return Math.min(Math.max(min, max), Math.max(min, current + delta));
}
export function ingotCastMax(batch: number | null, daily: number | null, holding: number | null) {
  return batch === null || daily === null || holding === null ? null : Math.max(0, Math.min(batch, daily, holding));
}
export function submitNotice(stage: string, message: string | null = null) {
  if (stage === 'CHECKING') return 'The answer got lost. It is being checked; wait before starting another.';
  if (stage === 'REFUSED') return message ?? 'The server refused it. Nothing was spent.';
  return null;
}
/** Recovery takes precedence over refresh errors: RETRY must never send a second original operation. */
export function craftGate(hydration: string, submit: string, saved: boolean): {action:string;label:string} | null {
  if (submit === 'SENDING') return {action:'NONE',label:'Sending'};
  if (submit === 'CHECKING') return {action:'NONE',label:'Being checked'};
  if (saved) return {action:'CHECK',label:'CHECK'};
  if (hydration === 'LOADING') return {action:'NONE',label:'Checking…'};
  if (hydration === 'ERROR') return {action:'RETRY',label:'Try again'};
  return null;
}
export const workshopTabs = [{id:'REFINE',label:'REFINE'},{id:'INGOTS',label:'INGOTS'},{id:'EQUIPMENT',label:'TOOLS'},{id:'COSMETICS',label:'STYLE'}] as const;
export const marketTabs = [{id:'BUY',label:'BUY'},{id:'SELL',label:'SELL'},{id:'MY ORDERS',label:'ORDERS'},{id:'COLLECTION',label:'OWNED'}] as const;
export function workshopDefaultTab(ingotReady: boolean, unseen: string | null, last: string | null, available: readonly string[]) {
  const tabs = available.length ? available : ['REFINE'];
  for (const tab of [ingotReady ? 'INGOTS' : null, unseen, last, 'REFINE']) if (tab !== null && tabs.includes(tab)) return tab;
  return tabs[0]!;
}
export interface CollectionUi {mode:'AUTO'|'SERVER';state:'WORKING'|'READY'|'COLLECTING'|'DELIVERED';id:string;receiptId:string|null}
export function collectionAction(job: CollectionUi) {
  if (job.mode === 'AUTO' && job.state === 'DELIVERED') return 'MARK_SEEN';
  if (job.mode === 'SERVER' && job.state === 'READY') return 'REVIEW_COLLECTION';
  if (job.mode === 'SERVER' && job.state === 'DELIVERED' && hasReceipt(job.receiptId)) return 'CELEBRATE';
  return 'NONE';
}
export function marketOrderCopy(state:string):string {
  const copy:Record<string,string>={OPEN:'On your stall',SOLD:'Sold',WITHDRAWING:'Taking your goods back',CLOSED:'Offer ended',CHECKING:'A sale is being checked'};
  return copy[state] ?? 'Your offer is being checked';
}
