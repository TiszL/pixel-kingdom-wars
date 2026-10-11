/** Earned material originals plus explicitly serialized finalized fixture banks.
 * Reuses the accepted real source; no validator, live identity or signing. */
import {randomBytes,randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {vi} from 'vitest';
import {normalizeVehicleIssuanceOriginal,createVehicleIssuanceEvidenceReader} from '@shardkeep/chain/vehicle-issuance-evidence';
import {createVehicleIssuanceTerminalReader} from '@shardkeep/chain/vehicle-issuance-terminal';
import {vehicleTermsHash,vehicleTermsBytes,vehicleVrfRequest,vehicleKeccak} from '@shardkeep/chain/vehicle-issuance-protocol';
import {vehicleIssuanceFixture} from '../../../../packages/chain/src/testFixtures/vehicleIssuance';
import {vehicleIssuanceTerminalFixture} from '../../../../packages/chain/src/testFixtures/vehicleIssuanceTerminal';
import {createVehicleCraftMaterials,type VehicleCraftMaterialRecord} from '../../src/game/vehicleCraftMaterials';
import {createVehicleCraftClient} from '../../src/game/vehicleCraftClient';
import {createVehicleClient} from '../../src/game/vehicleClient';
import type {VehicleClientCurrentRpc} from '@shardkeep/chain/vehicle-client-current';
import {withVehicleMaterialEarnedSource,type VehicleMaterialEarnedSource} from './vehicleMaterialEarnedSource';
function bank(saved:VehicleCraftMaterialRecord,outcome:'won'|'lost',minted=false){
 const b=minted?vehicleIssuanceFixture(saved.original.rootId):vehicleIssuanceTerminalFixture(outcome,{rootId:saved.original.rootId}),o=saved.original,terms=vehicleTermsHash(o),request=vehicleKeccak(vehicleVrfRequest(o.rootId,o.attemptId,terms)),buyer=new PublicKey(o.buyer).toBuffer();
 buyer.copy(b.rows[7]!.data,41);buyer.copy(b.rows[8]!.data,73);buyer.copy(b.rows[9]!.data,25);
 vehicleTermsBytes(o.terms).copy(b.rows[8]!.data,185);Buffer.from(terms,'hex').copy(b.rows[7]!.data,137);Buffer.from(terms,'hex').copy(b.rows[8]!.data,393);Buffer.from(terms,'hex').copy(b.rows[9]!.data,121);request.copy(b.rows[8]!.data,425);
 if(minted)buyer.copy(b.rows[10]!.data,1);
 return b;
}
async function fixture(source:VehicleMaterialEarnedSource){
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');
 const {db,seller}=source,identity={finalizedDeedReader:source.deedReader,deedCollection:source.collection};
 async function reserve(){const b=vehicleIssuanceFixture(randomBytes(16).toString('hex')),{originalHash:_h,...template}=b.original,materials=createVehicleCraftMaterials(db,{loadTemplate:async()=>normalizeVehicleIssuanceOriginal({...template,buyer:seller.wallet})});await source.refresh();return materials.reserve(seller.wallet,{idempotencyKey:randomUUID(),baseId:seller.baseId,family:source.recipe.family,tier:source.recipe.tier,recipeVersion:source.recipe.recipeVersion},seller.authority);}
 async function terminal(saved:VehicleCraftMaterialRecord,outcome:'won'|'lost'){const b=bank(saved,outcome);return createVehicleIssuanceTerminalReader(()=>b.rpc,b.trust,async()=>saved.original)(saved.original.rootId);}
 async function minted(saved:VehicleCraftMaterialRecord){const b=bank(saved,'won',true);return createVehicleIssuanceEvidenceReader(()=>b.rpc,b.trust,async()=>saved.original)(saved.original.rootId);}
 function candidates(saved:VehicleCraftMaterialRecord){const b=bank(saved,'won',true),pin=b.trust.core,unavailable=async()=>{throw Error('Read-only fixture: signing RPC unavailable');},rpc={...b.rpc,getSignatureStatuses:unavailable,getFeeForMessage:unavailable,getBalanceAndContext:unavailable,isBlockhashValid:unavailable,getBlockHeight:unavailable,sendRawTransaction:unavailable};return {bank:b,client:createVehicleClient(db,{current:{connect:()=>rpc as unknown as VehicleClientCurrentRpc,trust:{expectedGenesisHash:saved.original.genesisHash,reviewedDeploymentSlot:pin.reviewedDeploymentSlot,reviewedProgramDataSha256:pin.reviewedProgramDataSha256,upgradeAuthority:pin.upgradeAuthority}}})};}
 return {...source,identity,reserve,terminal,minted,candidates,client:createVehicleCraftClient(db,identity)};
}
export type VehicleCraftClientFixture=Awaited<ReturnType<typeof fixture>>;
export async function withVehicleCraftClientFixture(run:(f:VehicleCraftClientFixture)=>Promise<void>){try{await withVehicleMaterialEarnedSource(async source=>run(await fixture(source)));}finally{vi.unstubAllEnvs();}}
