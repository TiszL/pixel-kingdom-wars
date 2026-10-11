import type { FreeBasePurchaseView, FreeBasePurchaseReceipt } from '@shardkeep/shared/freeBasePurchaseApi';
export const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const identity={origin:'https://game.test',api:'https://game.test',cluster:'devnet' as const,wallet:'11111111111111111111111111111111'};
export const terms={policyVersion:1 as const,costShards:'100000',minKeepLevel:5,minWorkshopLevel:1,minGoldForgeLevel:1,maxFreeBases:2,maxActiveBases:5};
export const command={request:{sourceBaseId:id(1),idempotencyKey:id(2)},terms};
export const view=():FreeBasePurchaseView=>({version:1,wallet:identity.wallet,enabled:true,sourceBaseId:id(1),terms:{...terms},admission:{allowed:true,reason:'ready'},receipt:null});
export const receipt=():FreeBasePurchaseReceipt=>({version:1,wallet:identity.wallet,...command.request,baseId:id(3),slot:2,shardsCharged:terms.costShards,debitTransactionId:id(4),development:{keepId:id(5),keepLevel:5,workshopId:id(6),workshopLevel:1,goldForgeId:id(7),goldForgeLevel:1},acceptedAt:'2026-09-25T00:00:00Z'});
export const proof=(accepted:boolean)=>accepted?{status:'accepted' as const,receipt:receipt()}:{status:'unknown' as const,receipt:null};
