import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spotLayout, phaseHeadline, reachLayout, licenceAction, permitTileTap, permitSealCanArm, rewardsTabOf, rewardsIntro, termAction, deliverState, trialPrimaryState, bidderName, countdownCopy } from './MapLogic';
test('the spot sheet hides bidding when the server has auctions off and checks while loading',()=>{assert.equal(spotLayout('LIVE','SERVER_OFF',false,false).primary,'NONE');assert.equal(spotLayout('LIVE',null,true,false).primary,'CHECKING');assert.equal(spotLayout('OUTBID','OPEN',false,false).heldRow,true);assert.equal(spotLayout('KING','OPERATING',false,false).primary,'CLAIM');});
test('the Reach sheet picks its primary from status, deed and the data lane’s short flag',()=>{assert.equal(reachLayout('AVAILABLE',false,true).primary,'GET_LAND');assert.equal(reachLayout('AVAILABLE',true,true).primary,'GET_SKR');assert.equal(reachLayout('OFF',true,false).primary,'NONE');assert.equal(reachLayout('UNLOCKED_BY_ME',true,false).primary,'BUY_BASE');});
test('the licence primary follows the draw state',()=>{assert.equal(licenceAction('OPEN',true,null,false).primary,'ENTERED');assert.equal(licenceAction('MINE',true,null,true).primary,'CLAIM');assert.equal(licenceAction(null,null,null,false).primary,'LOCKED');});
test('the top bidder is a kingdom name or a Seeker player',()=>{assert.equal(bidderName(null),'a Seeker player');assert.equal(bidderName(' Elm '),'Elm');});
test('the countdown chip never invents a time',()=>{assert.equal(countdownCopy('SEEKER','OPEN',null,null)?.time,'…');assert.equal(countdownCopy('SEEKER','SERVER_OFF',null,null),null);assert.equal(countdownCopy('SOLANA',null,'NONE',null)?.time,null);});
test('permit tiles explain home and unavailable realms',()=>{assert.equal(permitTileTap('HOME'),'HOME');assert.equal(permitTileTap('NOT_SOLD'),'NOT_SOLD');assert.equal(permitTileTap('COVERED'),'SELECT');});
test('unknown or short prices never arm the permit Seal',()=>{for(const status of ['CHECKING','UNAVAILABLE','SHORT'] as const)assert.equal(permitSealCanArm(status,'READY'),false);assert.equal(permitSealCanArm('OK','SENDING'),false);assert.equal(permitSealCanArm('SERVER_ZERO','READY'),true);});
test('island rewards keep materials shards and realm cut separate',()=>{assert.equal(rewardsTabOf('KEEP_TAX'),'MATERIALS');assert.match(rewardsIntro('REALMS_CUT'),/KEEP to your wallet/);assert.equal(termAction('CHECKING'),'RECOVER');assert.equal(termAction('CLAIMED'),'NONE');});
test('uncertain attempts and fragments keep recovery ahead of another send',()=>{assert.equal(deliverState('ENABLED',true),'DISABLED');assert.equal(trialPrimaryState('ENABLED',true),'DISABLED');assert.equal(deliverState('BUSY',true),'BUSY');});
test('test auction phase headlines never claim live readiness',()=>{assert.equal(phaseHeadline(null),'…');assert.doesNotMatch(phaseHeadline('OPEN'),/LIVE/);});

// Compile-only regression, authored before narrowing. Node transpilation does not execute this assertion.
type AssertTrue<T extends true> = T;
export type ReachPrimaryMustBeClosed = AssertTrue<ReturnType<typeof reachLayout>['primary'] extends 'NONE'|'UNLOCK'|'GET_SKR'|'GET_LAND'|'BUY_BASE' ? true : false>;
