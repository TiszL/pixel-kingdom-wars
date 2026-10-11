/** VoyageLogic/VoyageR2Logic presentation gates. Unknowns stay unknown; no client time settles a trip. */
export interface VehicleGate {family:string;status:string;installationId:string|null;tripsLeft:number|null;maxGrade:number}
export interface RouteGate {routeId:string;grade:number;access:string;myTrip:{state:string}|null;permitReason:string|null}
export function vehicleCardState(v: VehicleGate, selected: string | null, grade: number | null): string {
  if (v.status === 'EMPTY' || !v.installationId) return 'EMPTY';
  if (v.status === 'AWAY') return 'AWAY';
  if (v.status === 'BUSY_SERVICE') return 'BUSY';
  if (v.status === 'WORN_OUT' || v.tripsLeft === 0) return 'WORN_OUT';
  if (grade !== null && v.family === 'STARTER') return 'COAST_ONLY';
  if (grade !== null && v.maxGrade < grade) return 'TOO_LOW_TIER';
  return v.installationId === selected ? 'SELECTED' : 'ELIGIBLE';
}
export function defaultVehicle<T extends VehicleGate>(vehicles: readonly T[], grade: number | null): T | null {
  const ready = vehicles.filter(v => v.status === 'DOCKED' && v.tripsLeft !== 0 && v.installationId);
  if (grade === null) return ready.find(v => v.family === 'STARTER') ?? null;
  return ready.filter(v => v.family !== 'STARTER' && v.maxGrade >= grade).sort((a,b) => a.maxGrade-b.maxGrade || (b.tripsLeft ?? -1)-(a.tripsLeft ?? -1))[0] ?? null;
}
export function islandTileState(route: RouteGate, tier: number | null, selected: string | null) {
  if (route.myTrip?.state === 'READY') return 'MY_TRIP_BACK';
  if (route.myTrip?.state === 'AT_SEA' || route.myTrip?.state === 'COLLECTING') return 'MY_TRIP_AWAY';
  if (tier === null || route.grade > tier) return 'LOCKED_TIER';
  if (route.access === 'PAID_REALM' && route.permitReason !== null) return 'LOCKED_PERMIT';
  return route.routeId === selected ? 'SELECTED' : 'AVAILABLE';
}
export function orderTrips<T extends {state:string;secondsLeft:number|null}>(trips: readonly T[]): T[] {
  const rank = (t:T) => t.state === 'READY' || t.state === 'COLLECTING' ? 0 : 1;
  return trips.filter(t=>t.state !== 'COLLECTED').sort((a,b)=>rank(a)-rank(b) || (a.secondsLeft ?? Infinity)-(b.secondsLeft ?? Infinity));
}
export interface SendGateUi {pending:boolean;busy:boolean;lockedReason:string|null;ordersAllowed:boolean;hasRoute:boolean;vehicle:VehicleGate|null;routeGrade:number|null;previewState:string;preview:{supplies:readonly {short:boolean;name:string;shortLine?:string|null}[];permit:object|null}|null}
export function sendGate(ui: SendGateUi): {action:'CHECK'|'NONE'|'EXPLAIN'|'PERMIT'|'SEND';reason:string|null} {
  if (ui.pending) return {action:'CHECK',reason:'Your departure is being checked'};
  if (ui.busy) return {action:'NONE',reason:'Sending'};
  if (ui.lockedReason) return {action:'EXPLAIN',reason:ui.lockedReason};
  if (!ui.ordersAllowed) return {action:'EXPLAIN',reason:'This base is read-only'};
  if (!ui.hasRoute) return {action:'EXPLAIN',reason:'Choose where it sails'};
  if (!ui.vehicle) return {action:'EXPLAIN',reason:'Choose a vehicle that can sail there'};
  const state = vehicleCardState(ui.vehicle, null, ui.routeGrade);
  if (state !== 'ELIGIBLE' && state !== 'SELECTED') return {action:'EXPLAIN',reason:state === 'WORN_OUT' ? 'No trips left. Restore them at the Berth.' : 'Choose a vehicle that can sail there'};
  if (ui.previewState === 'LOADING') return {action:'NONE',reason:'Checking route'};
  if (ui.previewState !== 'READY' || !ui.preview) return {action:'EXPLAIN',reason:"The Lodge can't reach the route chart. Try again."};
  const short = ui.preview.supplies.find(s=>s.short);
  if (short) return {action:'EXPLAIN',reason:short.shortLine ?? `Need more ${short.name}`};
  return {action:ui.preview.permit ? 'PERMIT' : 'SEND',reason:null};
}
export function collectable(t: {state:string;returned:readonly unknown[]|null}) { return t.state === 'READY' && t.returned !== null; }
export function rewardText(quantity: string | null) {
  const q = quantity?.trim(); return !q || q === '…' ? '…' : q.startsWith('+') || q.startsWith('-') ? q : `+${q}`;
}
export function passportSourceLine(state:string) {
  return state === 'OK' ? null : state === 'NOT_CONFIGURED' ? 'The passport is not open on this server yet.' : 'These records could not be verified. Check again later.';
}
/** Actual confirmation stays inside the existing P0 Seal/controller with its arming guard. */
export function sealIntent(state:string, authoritative:boolean) {
  if (state === 'ERROR') return authoritative ? 'RETRY' : 'CHECK';
  if (state === 'IDLE' || state === 'ARMED') return 'SHARED_SEAL';
  return 'NONE';
}

export function vehicleCopy(state:string):string {
  const copy:Record<string,string>={EMPTY:'Install a vehicle at the Berth',AWAY:'Your voyage is at sea',BUSY:'Service is being checked',WORN_OUT:'Restore trips at the Berth',COAST_ONLY:'This boat sails to the home coast',TOO_LOW_TIER:'A stronger vehicle is needed',SELECTED:'Your chosen vehicle',ELIGIBLE:'Ready to sail'};
  return copy[state] ?? 'The vehicle is being checked';
}
export function islandCopy(state:string):string {
  const copy:Record<string,string>={AVAILABLE:'Choose this island',SELECTED:'Your destination',LOCKED_TIER:'A stronger vehicle is needed',LOCKED_PERMIT:'A permit is needed',MY_TRIP_BACK:'Back at the Lodge',MY_TRIP_AWAY:'Your voyage is at sea'};
  return copy[state] ?? 'The route is being checked';
}
