import { test } from 'vitest';
import assert from 'node:assert/strict';
import { vehicleCardState, defaultVehicle, islandTileState, orderTrips, sendGate, collectable, rewardText, passportSourceLine, sealIntent } from './voyageLogic.ts';
const v=(x={})=>({family:'CARGO_CUTTER',status:'DOCKED',installationId:'v',tripsLeft:4,maxGrade:2,...x});
test('vehicle card states refuse away worn and under-tier boats', () => {
  assert.equal(vehicleCardState(v({status:'AWAY'}),'v',1),'AWAY');
  assert.equal(vehicleCardState(v({tripsLeft:0}),'v',1),'WORN_OUT');
  assert.equal(vehicleCardState(v({family:'STARTER'}),'v',1),'COAST_ONLY');
  assert.equal(vehicleCardState(v(),null,3),'TOO_LOW_TIER');
  assert.equal(vehicleCardState(v({status:'EMPTY',installationId:null}),null,1),'EMPTY');
});
test('default vehicle is docked and chooses the lowest suitable tier then most trips', () => {
  const best=v({installationId:'best',tripsLeft:8});
  assert.equal(defaultVehicle([v({status:'AWAY'}),v({maxGrade:3}),v(),best],2)?.installationId,'best');
  assert.equal(defaultVehicle([v()],null),null);
});
test('island tile states preserve trip and permit gates before selection', () => {
  const route={routeId:'r',grade:2,access:'HOME',myTrip:null,permitReason:null};
  assert.equal(islandTileState(route,null,'r'),'LOCKED_TIER');
  assert.equal(islandTileState({...route,myTrip:{state:'READY'}},null,'r'),'MY_TRIP_BACK');
  assert.equal(islandTileState({...route,access:'PAID_REALM',permitReason:'Not sold'},3,'r'),'LOCKED_PERMIT');
});
test('trips order, summary and the TRIPS primary', () => {
  const trips=[{tripId:'late',state:'AT_SEA',secondsLeft:9},{tripId:'unknown',state:'AT_SEA',secondsLeft:null},{tripId:'back',state:'READY',secondsLeft:null},{tripId:'old',state:'COLLECTED',secondsLeft:0}];
  assert.deepEqual(orderTrips(trips).map(t=>t.tripId),['back','late','unknown']);
});
test('SEND look follows the SPEC priority', () => {
  const ready={pending:false,busy:false,lockedReason:null,ordersAllowed:true,hasRoute:true,vehicle:v(),routeGrade:1,previewState:'READY',preview:{supplies:[],permit:null}};
  assert.equal(sendGate(ready).action,'SEND');
  assert.equal(sendGate({...ready,pending:true}).action,'CHECK');
  assert.equal(sendGate({...ready,busy:true}).action,'NONE');
  assert.equal(sendGate({...ready,ordersAllowed:false}).action,'EXPLAIN');
  assert.equal(sendGate({...ready,preview:null}).action,'EXPLAIN');
  assert.equal(sendGate({...ready,preview:{supplies:[{short:true,name:'Fibre'}],permit:null}}).action,'EXPLAIN');
});
test('unknown permit quotes navigate to review without confirming payment', () => {
  const quote={pending:false,busy:false,lockedReason:null,ordersAllowed:true,hasRoute:true,vehicle:v(),routeGrade:1,previewState:'READY',preview:{supplies:[],permit:{}}};
  assert.equal(sendGate(quote).action,'PERMIT');
});
test('due back is not collected until the server returns rewards', () => {
  assert.equal(collectable({state:'AT_SEA',secondsLeft:0,returned:null}),false);
  assert.equal(collectable({state:'READY',returned:null}),false);
  assert.equal(collectable({state:'READY',returned:[]}),true);
  assert.equal(collectable({state:'COLLECTING',returned:[]}),false);
});
test('unknown rewards do not acquire a plus sign or a zero', () => {
  for (const value of [null,'','…']) assert.equal(rewardText(value),'…');
  assert.equal(rewardText('4'),'+4');assert.equal(rewardText('+4'),'+4');
});
test('passport is a verified record and does not imply an item to buy', () => {
  assert.equal(passportSourceLine('OK'),null);
  assert.match(passportSourceLine('CONFLICT'),/could not be verified/);
});
test('money errors keep CHECK for an uncertain outcome and the shared Seal owns confirmation', () => {
  assert.equal(sealIntent('ERROR',false),'CHECK');assert.equal(sealIntent('ERROR',true),'RETRY');
  for (const state of ['CHECK_WALLET','SENDING','SENT']) assert.equal(sealIntent(state,false),'NONE');
  assert.equal(sealIntent('ARMED',true),'SHARED_SEAL');
});
