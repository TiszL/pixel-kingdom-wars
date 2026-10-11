import {describe,expect,it} from 'vitest';
import {PHASE_E_VEHICLES} from './constants';
import {PHASE_E_VEHICLE_FAMILY_IDS} from './phaseEVehicles';
import {AdvancedFleetEnvelopeSchema,AdvancedFleetRequestSchema,AdvancedFleetVehicleSchema,matchAdvancedFleetEnvelope} from './advancedFleetApi';

const baseId='10000000-0000-4000-8000-000000000001',otherBase='10000000-0000-4000-8000-000000000002';
const wallet='So11111111111111111111111111111111111111112',other='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const limit=PHASE_E_VEHICLES.completedUsesPerInstall;
function vehicle(index=0){return {installationId:`20000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,berthId:`30000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,
 family:PHASE_E_VEHICLE_FAMILY_IDS[index%PHASE_E_VEHICLE_FAMILY_IDS.length]!,tier:1,revision:0,completedTotal:'3',allowanceStart:'0',remainingUses:limit-3,away:false,pendingService:false};}
function envelope(){return {version:1,wallet,baseId,serverNow:'2035-01-01T01:00:00.000Z',acceptingNewActions:true,vehicles:[vehicle()]};}

describe('redacted advanced fleet contract',()=>{
 it('accepts an owned empty fleet and all advanced families without starter reinterpretation',()=>{
  expect(matchAdvancedFleetEnvelope({...envelope(),vehicles:[]},wallet,baseId).vehicles).toEqual([]);
  const vehicles=PHASE_E_VEHICLE_FAMILY_IDS.map((_,index)=>vehicle(index));expect(vehicles).toHaveLength(PHASE_E_VEHICLES.advancedFamilyCount);
  expect(AdvancedFleetEnvelopeSchema.parse({...envelope(),vehicles}).vehicles).toEqual(vehicles);
  expect(AdvancedFleetVehicleSchema.safeParse({...vehicle(),family:'starter'}).success).toBe(false);
 });
 it.each(['installationId','berthId','family'] as const)('requires a unique %s in the current base snapshot',field=>{
  const first=vehicle(),second={...vehicle(1),[field]:first[field]};expect(AdvancedFleetEnvelopeSchema.safeParse({...envelope(),vehicles:[first,second]}).success).toBe(false);
 });
 it('bounds rows by the shared advanced-family count',()=>{
  const vehicles=Array.from({length:PHASE_E_VEHICLES.advancedFamilyCount+1},(_,index)=>vehicle(index));expect(AdvancedFleetEnvelopeSchema.safeParse({...envelope(),vehicles}).success).toBe(false);
 });
 it('matches the authenticated wallet and exact stable base',()=>{
  expect(()=>matchAdvancedFleetEnvelope(envelope(),other,baseId)).toThrow();expect(()=>matchAdvancedFleetEnvelope(envelope(),wallet,otherBase)).toThrow();
  expect(()=>matchAdvancedFleetEnvelope(envelope(),wallet,'not-a-base')).toThrow();
 });
 it('derives remaining uses from lifetime completions and the latest allowance',()=>{
  for(const [completedTotal,allowanceStart,remainingUses] of [[String(limit),'0',0],[String(limit),String(limit),limit],[String(2*limit+3),String(2*limit),limit-3],['9223372036854775807','9223372036854775807',limit]] as const){
   const row={...vehicle(),completedTotal,allowanceStart,remainingUses};expect(AdvancedFleetVehicleSchema.parse(row)).toEqual(row);
  }
  for(const mutation of [{remainingUses:limit},{completedTotal:'2',allowanceStart:'3'},{completedTotal:String(limit+1),allowanceStart:'0',remainingUses:0},{remainingUses:-1},{remainingUses:0.5}])expect(AdvancedFleetVehicleSchema.safeParse({...vehicle(),...mutation}).success).toBe(false);
 });
 it.each(['completedTotal','allowanceStart'] as const)('rejects noncanonical or overflowing %s',field=>{
  for(const value of ['-1','01','1.0','1e2','', '9223372036854775808'])expect(AdvancedFleetVehicleSchema.safeParse({...vehicle(),[field]:value}).success).toBe(false);
  expect(AdvancedFleetVehicleSchema.safeParse({...vehicle(),[field]:3}).success).toBe(false);
 });
 it('requires shared family/tier values and a safe current revision',()=>{
  for(const family of ['unknown','starter',null])expect(AdvancedFleetVehicleSchema.safeParse({...vehicle(),family}).success).toBe(false);
  for(const tier of [0,PHASE_E_VEHICLES.tiers.at(-1)!+1,1.5,'1'])expect(AdvancedFleetVehicleSchema.safeParse({...vehicle(),tier}).success).toBe(false);
  for(const revision of [-1,0.5,Number.MAX_SAFE_INTEGER,'0'])expect(AdvancedFleetVehicleSchema.safeParse({...vehicle(),revision}).success).toBe(false);
  expect(AdvancedFleetVehicleSchema.safeParse({...vehicle(),revision:Number.MAX_SAFE_INTEGER-1}).success).toBe(true);
 });
 it('treats pause and wall-clock fields as observations without inventing completion or service release',()=>{
  const busy={...vehicle(),away:true},pending={...vehicle(1),pendingService:true};
  const raw={...envelope(),acceptingNewActions:false,serverNow:'2099-01-01T01:00:00.000Z',vehicles:[busy,pending]};expect(AdvancedFleetEnvelopeSchema.parse(raw)).toEqual(raw);
  for(const field of ['away','pendingService'])expect(AdvancedFleetVehicleSchema.safeParse({...vehicle(),[field]:'true'}).success).toBe(false);
  expect(AdvancedFleetEnvelopeSchema.safeParse({...envelope(),acceptingNewActions:1}).success).toBe(false);
 });
 it('requires canonical lowercase UUIDs and actual millisecond UTC timestamps',()=>{
  for(const baseId of ['ABCDEFAB-0000-4000-8000-000000000001','not-a-uuid'])expect(AdvancedFleetRequestSchema.safeParse({baseId}).success).toBe(false);
  for(const serverNow of ['2035-02-30T01:00:00.000Z','2035-01-01T01:00:00Z','2035-01-01T01:00:00.000001Z','2035-01-01T01:00:00.000+00:00'])expect(AdvancedFleetEnvelopeSchema.safeParse({...envelope(),serverNow}).success).toBe(false);
  expect(AdvancedFleetEnvelopeSchema.safeParse({...envelope(),wallet:'1'.repeat(32)}).success).toBe(false);
 });
 it('rejects caller authority and every private service or seller field',()=>{
  for(const extra of [{wallet},{installationId:vehicle().installationId},{proof:{}},{enabled:true}])expect(AdvancedFleetRequestSchema.safeParse({baseId,...extra}).success).toBe(false);
  for(const extra of [{sellerWallet:other},{wallet:other},{assetId:wallet},{intentId:otherBase},{idempotencyKey:'seller-key'},{messageHex:'ab'},{signedTransactionHex:'ab'},{proof:{}},{serviceAuthorized:true},{returnsAt:'2035-01-01T01:00:00.000Z'}])expect(AdvancedFleetVehicleSchema.safeParse({...vehicle(),...extra}).success).toBe(false);
  expect(AdvancedFleetEnvelopeSchema.safeParse({...envelope(),proof:{}}).success).toBe(false);expect(AdvancedFleetEnvelopeSchema.safeParse({...envelope(),version:2}).success).toBe(false);
 });
 it('returns independent parsed rows without mutating input or accepted history',()=>{
  const raw=envelope(),saved=matchAdvancedFleetEnvelope(raw,wallet,baseId);raw.vehicles[0]!.completedTotal='99';raw.vehicles[0]!.pendingService=true;raw.vehicles.push(vehicle(1));expect(saved.vehicles).toEqual([vehicle()]);
  saved.vehicles[0]!.away=true;expect(raw.vehicles[0]!.away).toBe(false);
 });
});
