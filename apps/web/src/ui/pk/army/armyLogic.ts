/** Pure presentation rules ported from ArmyLogic/ArmyR2Logic. Server values are inputs, never game constants. */
export interface HousingUi { ready: number; training: number; draft: number; capacity: number; known: boolean; full: boolean }
export interface DraftLine { troop: string; pts: number; count: number }
export function housingFractions(h: HousingUi, showDraft = true) {
  if (!h.known || h.capacity <= 0) return {ready: 0, training: 0, draft: 0};
  const ready = Math.min(1, Math.max(0, h.ready) / h.capacity);
  const training = Math.min(1 - ready, Math.max(0, h.training) / h.capacity);
  const draft = showDraft ? Math.min(Math.max(0, 1 - ready - training), Math.max(0, h.draft) / h.capacity) : 0;
  return {ready, training, draft};
}
export function canAddTroop(h: HousingUi, pts: number) {
  return h.known && !h.full && pts > 0 && Math.max(0, h.capacity - h.ready - h.training - h.draft) >= pts;
}
export function trimDraft(room: number, wanted: readonly DraftLine[]) {
  let left = Math.max(0, room), droppedTroops = 0;
  const kept: DraftLine[] = [];
  for (const line of wanted) {
    const count = Math.max(0, line.count), fit = line.pts > 0 ? Math.min(count, Math.floor(left / line.pts)) : 0;
    left -= fit * Math.max(0, line.pts); droppedTroops += count - fit;
    if (fit > 0) kept.push({...line, count: fit});
  }
  return {kept, droppedTroops};
}
export interface CommandGate {state: string; price: {status: string} | null}
export function commandTap(cmd: CommandGate): 'RUN' | 'NEED_MORE' | 'EXPLAIN' | 'IGNORE' {
  if (cmd.state === 'BUSY') return 'IGNORE';
  if (cmd.state === 'SHORT') return 'NEED_MORE';
  if (cmd.state !== 'ENABLED') return 'EXPLAIN';
  if (cmd.price?.status === 'UNAVAILABLE') return 'EXPLAIN';
  return cmd.price?.status === 'SHORT' ? 'NEED_MORE' : 'RUN';
}
export function researchTap(state: string, labBusy: boolean) {
  if (labBusy || state === 'IN_LAB' || state === 'BUSY') return 'BUSY';
  if (state === 'DEFAULT' || state === 'SELECTED') return 'SELECT';
  return ({SHORT:'NEED_MORE', LAB_CAP:'LAB_CAP', LOCKED:'LOCKED'} as Record<string,string>)[state] ?? 'NONE';
}
export function revengeLook(state: string, action: string, attacker: string, gate: string | null = null, unavailableNote: string | null = null) {
  if (state === 'ANSWERED') return {kind:'ANSWERED',label:'ANSWERED',note:null};
  if (state === 'UNAVAILABLE') return {kind:'GONE',label:'REVENGE',note:unavailableNote ?? "Can't be answered now"};
  if (action === 'BUSY') return {kind:'BUSY',label:'Finding a base',note:null};
  if (action === 'CHECKING') return {kind:'RETRY',label:'RETRY',note:'Being checked'};
  if (gate !== null) return {kind:'OFF',label:'REVENGE',note:gate};
  return {kind:'REVENGE',label:'REVENGE',note:null};
}
export function scoutCommands<T>(source: string, home: T, skip: T | null, attack: T): T[] {
  return source === 'MATCH' && skip !== null ? [home, skip, attack] : [home, attack];
}
export function settlementRows<T>(settlement: string, rows: readonly T[]): readonly T[] {
  return settlement === 'SETTLED' ? rows : [];
}
