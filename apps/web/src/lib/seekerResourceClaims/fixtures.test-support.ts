import type { SeekerResourceClaimReceipt, SeekerResourceEntitlementView } from '@shardkeep/shared/seekerResourceClaimsApi';
export const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const identity={origin:'https://game.test',api:'https://game.test',cluster:'devnet' as const,wallet:'11111111111111111111111111111111'};
export const command={request:{baseId:id(1),idempotencyKey:id(2),termId:id(3),resourceId:'heartwood_logs' as const,spotId:0},termHash:'a'.repeat(64),browseCursor:null};
export const receipt=():SeekerResourceClaimReceipt=>({...command.request,id:id(2),wallet:identity.wallet,termHash:command.termHash,winnerCount:2,poolTotal:'20',previousTotal:'0',cumulativeTotal:'10',quantity:'10',stockBefore:'3',stockAfter:'13',claimedAt:'2026-09-25T00:00:00.000Z',shardsIncluded:false});
export const proof=(accepted:boolean)=>({wallet:identity.wallet,receipt:accepted?receipt():null});
export const view=():SeekerResourceEntitlementView=>({version:1,wallet:identity.wallet,claimsEnabled:true,shardsIncluded:false,status:'available',reason:null,cursor:null,nextCursor:null,rows:[{termId:id(3),termHash:command.termHash,startsAt:'2026-09-20T00:00:00.000Z',endsAt:'2026-09-27T00:00:00.000Z',spotId:0,resourceId:'heartwood_logs',winnerCount:2,poolTotal:'20',cumulativeTotal:'10',claimedTotal:'0',dueQuantity:'10'}]});
