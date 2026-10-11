import {describe,expect,it} from 'vitest';
import * as v from './voyageNativeLogic';
import type {VehicleUi,RouteUi,TripUi,PreviewUi,SendLookInput} from './voyageNativeLogic';

const vehicle=(family:VehicleUi['family'],tier:number|null,id:string,status:VehicleUi['status']='DOCKED',left:number|null=7,returnsAt:string|null=null):VehicleUi=>({family,tier,installationId:id,berthId:`berth-${id}`,status,tripsLeft:left,tripsMax:10,returnsAt,maxGrade:tier??0});
const route=(id:string,realm:string,grade:number,access:RouteUi['access']='HOME',myTrip:RouteUi['myTrip']=null,permitReason:string|null=null):RouteUi=>({routeId:id,realmId:realm,realmName:realm[0]!.toUpperCase()+realm.slice(1),grade,access,myTrip,permitReason,resourceIcon:'',resourceName:''});
const trip=(tripId:string,state:TripUi['state'],secondsLeft:number|null):TripUi=>({tripId,state,secondsLeft,expected:[{quantity:'40',name:'Heartwood Logs'}],returned:null});
const preview:PreviewUi={returnsAtLocal:'21:40',supplies:[],permit:null};
const look=(patch:Partial<SendLookInput>={})=>v.sendLook({hasRoute:true,hasVehicle:true,previewState:'READY',preview,ordersAllowed:true,ordersReason:null,lockedReason:null,busy:false,pending:false,previewError:null,...patch});
describe('VoyageLogic native parity — authored, unrun',()=>{
  // Unknown server values must never read as a real number (DESIGN-SYSTEM §9: unknown is "…", never 0).
  it('unknown trips and tiers render as the ellipsis, never zero',()=>{
    expect(v.tripsLeftShort(null,10)).toBe('…/10 left');expect(v.tripsLeftLong(7,null)).toBe('7 of … trips left');
    expect(v.tripsFraction(null,10),'an unknown meter is an empty track, not 0 % done').toBeNull();expect(v.tripsFraction(3,0)).toBeNull();expect(v.tierTag(null)).toBe('T…');expect(v.gradeNumeral(7)).toBe('…');
    expect(v.vehicleTitle(vehicle('CARGO_CUTTER',null,'c'))).toBe('Cargo Cutter T…');expect(v.vehicleTitle(vehicle('STARTER',null,'s'))).toBe('Starter Boat');
  });
  // SPEC §7 / §9: the meter warns (gold) when two trips or fewer remain, so service comes before a dead vehicle.
  it('the trips meter turns gold at two trips left',()=>{
    expect([2,0,3,null].map(v.tripsMeterVerb)).toEqual(['GOLD','GOLD','GREEN','GREEN']);expect(v.tripsFraction(7,10)).toBeCloseTo(.7);
  });
  // SPEC §3 table: a vehicle at sea is AWAY whatever else is true; worn out reads "Service" before a tier problem, because
  // service is the fix; the starter on an island route is "Coast only"; a tier below the grade is "Needs Tn".
  it('vehicle card states follow the SPEC priority',()=>{
    expect(v.vehicleCardState(vehicle('CARGO_CUTTER',1,'a','AWAY',0),null,3)).toBe('AWAY');
    expect(v.vehicleCardState(vehicle('CARGO_CUTTER',1,'w','DOCKED',0),null,3)).toBe('WORN_OUT');
    expect(v.vehicleCardState(vehicle('STARTER',null,'s'),null,1)).toBe('COAST_ONLY');expect(v.vehicleCardState(vehicle('SURVEY_BALLOON',1,'b'),null,2)).toBe('TOO_LOW_TIER');
    expect(v.vehicleCardState(vehicle('CARGO_CUTTER',2,'c'),'c',2)).toBe('SELECTED');expect(v.vehicleCardState(vehicle('CARGO_CUTTER',3,'c'),'x',2)).toBe('ELIGIBLE');
    expect(v.vehicleCardLine(vehicle('SURVEY_BALLOON',1,'b'),'TOO_LOW_TIER',2)).toBe('Needs T2');
    expect(v.vehicleCardLine(vehicle('COURIER_AIRSHIP',3,'a','AWAY',7,'1h 12m'),'AWAY',2)).toBe('1h 12m');
    expect(v.canSelect('AWAY')).toBe(false);expect(v.canSelect('ELIGIBLE')).toBe(true);
  });
  // SPEC §3 item 6: never spend a stronger vehicle than the island needs; among equals keep the one with most trips left.
  it('the default vehicle is the lowest tier that reaches the grade, then most trips left',()=>{
    const all=[vehicle('COURIER_AIRSHIP',3,'t3'),vehicle('CARGO_CUTTER',2,'t2few','DOCKED',2),vehicle('SURVEY_BALLOON',2,'t2many','DOCKED',9),vehicle('SURVEY_BALLOON',1,'t1'),vehicle('EXPEDITION_BARGE',2,'away','AWAY',10),vehicle('EXPEDITION_BARGE',2,'worn','DOCKED',0),vehicle('STARTER',null,'s')];
    expect(v.defaultVehicle(all,2)?.installationId).toBe('t2many');expect(v.defaultVehicle(all,1)?.installationId).toBe('t1');expect(v.defaultVehicle(all,4),'nothing docked reaches Grade IV').toBeNull();expect(v.defaultVehicle(all,null)?.installationId,'a starter route defaults to the starter').toBe('s');
  });
  // SPEC §4: CAN SAIL counts what a docked vehicle reaches; counts are "…" while loading, never a guessed 0.
  it('picker filters and counts',()=>{
    const routes=[1,2,3,4].flatMap(g=>[route(`home-${g}`,'elderwood',g),route(`paid-${g}`,'cinderfall',g,'PAID_REALM')]);
    expect(v.filterRoutes(routes,'ALL',2)).toHaveLength(8);expect(v.filterRoutes(routes,'CAN_SAIL',2)).toHaveLength(4);expect(v.filterRoutes(routes,'CAN_SAIL',null)).toHaveLength(0);expect(v.filterRoutes(routes,'HOME',null)).toHaveLength(4);
    expect(v.filterCount(routes,'ALL',2,true)).toBe('…');expect(v.filterCount(routes,'CAN_SAIL',2,false)).toBe('4');
  });
  // SPEC §4 item 4: the home realm leads, the rest are alphabetical, islands by grade.
  it('realm blocks put home first then alphabetical',()=>{
    const blocks=v.realmBlocks([route('f2','frostveil',2),route('c1','cinderfall',1),route('e3','elderwood',3),route('e1','elderwood',1)],'elderwood');
    expect(blocks.map(b=>b.realmId)).toEqual(['elderwood','cinderfall','frostveil']);expect(blocks[0]?.routes.map(r=>r.grade)).toEqual([1,3]);
  });
  // SPEC §4 tile table: my own trip is a door (TRIPS / collect) even on a locked island; locks come before selection.
  it('island tile states',()=>{
    expect(v.islandTileState(route('r','x',4,'HOME',{tripId:'t',state:'READY'}),1,'r')).toBe('MY_TRIP_BACK');expect(v.islandTileState(route('r','x',4,'HOME',{tripId:'t',state:'AT_SEA'}),1,null)).toBe('MY_TRIP_AWAY');
    expect(v.islandTileState(route('r','x',3),2,'r')).toBe('LOCKED_TIER');expect(v.islandTileState(route('r','x',1,'PAID_REALM',null,'Permits sold out'),2,null)).toBe('LOCKED_PERMIT');
    expect(v.islandTileState(route('r','x',1,'PAID_REALM'),2,null)).toBe('AVAILABLE');expect(v.islandTileState(route('r','x',2),2,'r')).toBe('SELECTED');
  });
  // SPEC §4 item 3: the header tells the player when a vehicle that unlocks the grade comes back.
  it('grade header shows when an away vehicle unlocks a grade',()=>{
    expect(v.gradeHeaderLine(2,2,{3:'1h'})).toEqual(['needs T2+',false]);expect(v.gradeHeaderLine(3,2,{3:'1h',4:'5h'})).toEqual(['T3+ in 1h',true]);expect(v.gradeHeaderLine(3,null,{4:'5h',3:'1h'}),'the lowest away tier that reaches the grade wins').toEqual(['T3+ in 1h',true]);expect(v.gradeHeaderLine(4,2,{3:'1h'})).toEqual(['needs T4+',false]);
  });
  // SPEC §5a: READY first (collect is one tap), then the soonest return; unknown times last.
  it('trips order, summary and the TRIPS primary',()=>{
    const trips=[trip('late','AT_SEA',9000),trip('unknown','AT_SEA',null),trip('back','READY',null),trip('soon','AT_SEA',60),trip('done','COLLECTED',null)];
    expect(v.orderTrips(trips).map(t=>t.tripId)).toEqual(['back','soon','late','unknown']);expect(v.tripsSummary(trips)).toBe('3 at sea · 1 back');expect(v.tripsPrimary(trips,[])).toBe('COLLECT');
    const away=trips.filter(t=>t.state==='AT_SEA');expect(v.tripsPrimary(away,[vehicle('SURVEY_BALLOON',1,'b')])).toBe('SEND_ANOTHER');expect(v.tripsPrimary(away,[vehicle('SURVEY_BALLOON',1,'b','DOCKED',0)])).toBe('NONE');
    expect(v.collectSubLine(trips)).toBe('+40 Heartwood Logs');expect(v.collectSubLine([...trips,trip('back2','READY',null)])).toBe('2 trips back');
  });
  it('trips tab badge is green when back, red count at sea, none when idle',()=>{
    expect(v.tripsTabBadge([trip('a','READY',null),trip('b','AT_SEA',5)])).toEqual(['!',true]);expect(v.tripsTabBadge([trip('a','AT_SEA',1),trip('b','AT_SEA',5)])).toEqual(['2',false]);expect(v.tripsTabBadge([])).toBeNull();
  });
  // SPEC §3 states: a departure in flight is checked, never re-sent; LOCKED/DISABLED always carry a reason.
  it('SEND look follows the SPEC priority',()=>{
    expect(look({pending:true,busy:true})).toMatchObject({state:'BUSY',label:'Checking departure'});expect(look({lockedReason:'Expeditions are not open on this server yet'}).state).toBe('LOCKED');
    expect(look({ordersAllowed:false}).reason).toBe('This base is read-only');expect(look({busy:true}).label).toBe('Sending');expect(look({hasRoute:false}).reason).toBe('Choose an island first');expect(look({previewState:'LOADING'}).label).toBe('Checking route');expect(look({previewState:'ERROR',preview:null}).state).toBe('DISABLED');
    expect(look({preview:{...preview,supplies:[{name:'Thorn Fibre',short:true,shortLine:'Need 4 more Thorn Fibre'}]}}).reason).toBe('Need 4 more Thorn Fibre');expect(look()).toMatchObject({state:'ENABLED',sub:'back at 21:40'});
  });
  // M48 / money honesty: a permit the server has not priced is never shown as free.
  it('an unpriced permit reads as the ellipsis',()=>{
    expect(look({preview:{...preview,permit:{price:{currency:'SOL',amount:null,status:'CHECKING'},realmName:'Cinderfall'}}}).sub).toBe('permit about … SOL');expect(v.permitAmount({price:{currency:'SOL',amount:'0.03',status:'OK'},realmName:'Cinderfall'})).toBe('0.03 SOL');
  });
  // SPEC §7 item 7: an install in flight offers CHECK (by-key recovery), never a second INSTALL.
  it('fleet primary per selection',()=>{
    const empty:VehicleUi={...vehicle('SURVEY_BALLOON',null,'b'),installationId:null,status:'EMPTY',tripsLeft:null,tripsMax:null};
    expect(v.fleetPrimary(empty,true,null,true,true).action).toBe('CHECK');expect(v.fleetPrimary(empty,false,null,false,true).look?.state).toBe('LOCKED');expect(v.fleetPrimary(empty,false,null,true,true).look?.label).toBe('INSTALL BALLOON');
    expect(v.fleetPrimary(empty,false,'Vehicles are not open on this server yet',true,true).look?.state).toBe('LOCKED');expect(v.fleetPrimary(vehicle('COURIER_AIRSHIP',3,'a','AWAY'),false,null,true,true).action).toBe('NONE');expect(v.fleetPrimary(vehicle('CARGO_CUTTER',2,'c','DOCKED',0),false,null,true,true).action).toBe('SERVICE');expect(v.fleetPrimary(vehicle('CARGO_CUTTER',2,'c'),false,null,true,true)).toMatchObject({action:'SEND_FROM_LODGE',look:{verb:'BLUE'}});
  });
  // The starter is never serviced; unknown trips do not count; one trip left does.
  it('berth rows and the service badge',()=>{
    const empty={...vehicle('SURVEY_BALLOON',null,'b'),status:'EMPTY' as const};
    expect(v.berthRowTag(empty)).toEqual(['EMPTY','STONE']);expect(v.berthRowTag(vehicle('CARGO_CUTTER',2,'c','DOCKED',0))).toEqual(['SERVICE','RED']);expect(v.berthRowTag(vehicle('CARGO_CUTTER',2,'c','AWAY'))).toEqual(['AWAY','BLUE']);
    expect(v.berthRowLine(vehicle('COURIER_AIRSHIP',3,'a','AWAY'))).toBe('At sea · 7 of 10 trips left');expect(v.berthRowLine(vehicle('STARTER',null,'s'))).toBe('Coast trips · always free');expect(v.berthRowLine(empty)).toBe('Empty · flies to Grade I+');
    expect(v.serviceBadgeCount([vehicle('STARTER',null,'s','DOCKED',0),vehicle('CARGO_CUTTER',2,'c','DOCKED',1),vehicle('COURIER_AIRSHIP',3,'a','DOCKED',null),vehicle('SURVEY_BALLOON',1,'b','DOCKED',2)])).toBe(1);
  });
  it('service primary needs the hand-in and says the fee',()=>{
    expect(v.servicePrimary('RESTORE_USES',true,null,null,false,'Cargo Cutter T2','0.00002',false,null)).toMatchObject({state:'DISABLED',reason:'You need a Cargo Cutter T2 in your wallet'});
    // An unreviewed fee is never 0.
    expect(v.servicePrimary('UPGRADE',true,null,3,true,'Cargo Cutter T2',null,false,null)).toMatchObject({label:'UPGRADE TO T3',sub:'network fee about … SOL'});
    expect(v.servicePrimary('UPGRADE',false,'Max tier',null,true,'x','1',false,null)?.state).toBe('LOCKED');expect(v.servicePrimary(null,true,null,null,true,'x','1',false,null)).toBeNull();
  });
  // Design correction 7: only an authoritative refusal may say nothing was sent; an uncertain result is being checked.
  it('money errors never claim nothing was sent unless the refusal is authoritative',()=>{
    expect(v.moneyErrorLine({message:"Wallet didn't answer.",authoritative:false})).toBe("Wallet didn't answer. Your request is being checked.");expect(v.moneyErrorLine({message:'You declined in the wallet',authoritative:true})).toBe('You declined in the wallet. Nothing was sent.');
    expect(v.moneyError('x',false).recoverable).toBe(true);expect(v.moneyError('x',true).recoverable).toBe(false);expect(v.moneyStage('ARMED')).toBe('READY');expect(v.moneyStage('ERROR')).toBe('FAILED');expect(v.moneyStage('SENT')).toBe('SENT');
  });
  // SPEC §0.4: art is drawn at a whole number of device pixels per art pixel (k is written at density 2.0).
  // A bottom-anchored berth: art row 94 sits on the window's bottom edge.
  // x: 41 − 48 × 2 = −55 (art x 48 on the window's centre); y: 114 − 94 × 2 = −74.
  // A centred sprite: the art point lands on the window centre.
  it('pixel art scale and windows are whole device pixels',()=>{
    expect([[2,2],[2,3],[2,3.5],[1,1],[1,.5]].map(([k,d])=>v.deviceArtScale(k!,d!))).toEqual([2,3,4,1,1]);
    expect(v.spriteOrigin(82,114,2,48,0,94)).toEqual([-55,-74]);expect(v.spriteOrigin(112,112,2,28,28)).toEqual([0,0]);expect(v.vehicleBbox('STARTER')).toEqual([47,71,65,105]);
  });
  // Every colour row is the same luma row, scaled by brightness; alpha untouched.
  it('dim matrix keeps colour at zero grey and greys fully at one',()=>{
    const identity=v.dimMatrix(0,1);expect(identity[0]).toBeCloseTo(1);expect(identity[1]).toBeCloseTo(0);expect(identity[6]).toBeCloseTo(1);expect(identity[18]).toBeCloseTo(1);
    const grey=v.dimMatrix(1,.5);expect(grey[0]).toBeCloseTo(grey[5]!);expect(grey[1]).toBeCloseTo(grey[11]!);expect(grey[0]).toBeCloseTo(.2126*.5);expect(grey[18]).toBeCloseTo(1);expect(grey).toHaveLength(20);
  });
  // SPEC §3 item 2: the route runs across, then up or down, then across; a vehicle sits on it by share of length.
  // Length 50 + 40 + 50 = 140; half way (70) is 20 up the vertical leg at x 50.
  it('stepped route points',()=>{
    expect(v.steppedRoutePoint(0,100,100,60,0)).toEqual([0,100]);expect(v.steppedRoutePoint(0,100,100,60,1)).toEqual([100,60]);expect(v.steppedRoutePoint(0,100,100,60,.5)).toEqual([50,80]);expect(v.steppedRoutePoint(0,0,0,0,.5)).toEqual([0,0]);
  });
});
