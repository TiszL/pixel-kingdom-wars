/** Local ephemeral key + serialized finalized bank. No live issuance authority. */
import {createPrivateKey,sign as cryptoSign,randomBytes,randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {vehicleIssuanceAdmissionFixture} from '../../../../packages/chain/src/testFixtures/vehicleIssuanceAdmission';
import {vehicleIssuanceFixture} from '../../../../packages/chain/src/testFixtures/vehicleIssuance';
import {normalizeVehicleIssuanceOriginal} from '@shardkeep/chain/vehicle-issuance-evidence';
import {vehicleKeccak} from '@shardkeep/chain/vehicle-issuance-protocol';
import {vehicleCraftRecipe,vehicleRecipeCanonical,VEHICLE_RECIPE_HASH_DOMAIN} from '@shardkeep/shared/phaseEVehicleRecipes';
import {vehicleCraftMaterialHash,type VehicleCraftMaterialRecord} from '../../src/game/vehicleCraftMaterials';
export function signVehiclePolicy(key:Keypair,message:Uint8Array){return cryptoSign(null,message,createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(key.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'}));}
export function syntheticVehicleMaterial(overrides:Partial<VehicleCraftMaterialRecord>={}):VehicleCraftMaterialRecord{
 const {originalHash:_ignored,...template}=vehicleIssuanceFixture(randomBytes(16).toString('hex')).original;
 const recipe=vehicleCraftRecipe(template.identity.family,template.identity.tier),recipeHash=vehicleKeccak(Buffer.from(VEHICLE_RECIPE_HASH_DOMAIN+vehicleRecipeCanonical(recipe))).toString('hex');
 const row={id:randomUUID(),actorWallet:template.buyer,request:{baseId:randomUUID(),idempotencyKey:randomUUID(),family:recipe.family,tier:recipe.tier,recipeVersion:recipe.recipeVersion},nonce:randomBytes(32).toString('hex'),reservedAt:'2023-11-14T22:13:20.000000Z',recipe,recipeHash,status:'held' as const,terminal:null,...overrides};
 const materialHash=vehicleCraftMaterialHash({actorWallet:row.actorWallet,baseId:row.request.baseId,rootId:template.rootId,attemptId:template.attemptId,nonce:row.nonce,recipeHash:row.recipeHash,recipe:row.recipe});
 const original=normalizeVehicleIssuanceOriginal({...template,buyer:row.actorWallet,terms:{...template.terms,recipeVersion:row.recipe.recipeVersion,recipeHash:row.recipeHash,materialHash,oddsBps:row.recipe.oddsBps}});
 return {...row,materialHash,original,...overrides};
}
export function vehiclePolicyBank(policy=Keypair.generate()){
 const f=vehicleIssuanceAdmissionFixture();Buffer.from(policy.publicKey.toBytes()).copy(f.rows[6]!.data as Buffer,41);
 return {...f,policy,policyAuthority:policy.publicKey.toBase58()};
}
