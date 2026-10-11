import type { SeekerShardsClaimReceipt, SeekerShardsEntitlementView } from '@shardkeep/shared/seekerShardsClaimsApi';
export const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const identity={origin:'https://game.test',api:'https://game.test',cluster:'devnet' as const,wallet:'11111111111111111111111111111111'};
export const command={request:{baseId:id(1),idempotencyKey:id(2),termId:id(3),spotId:0},termHash:'a'.repeat(64),browseCursor:null};
export const receipt=():SeekerShardsClaimReceipt=>({...command.request,id:id(2),wallet:identity.wallet,termHash:command.termHash,winnerCount:2,poolTotal:'20',previousTotal:'0',cumulativeTotal:'10',quantity:'10',balanceBefore:'3',balanceAfter:'13',claimedAt:'2026-09-25T00:00:00.000Z',currency:'SHARDS',ledgerTransactionId:id(4)});
export const proof=(accepted:boolean)=>({wallet:identity.wallet,receipt:accepted?receipt():null});
export const view=():SeekerShardsEntitlementView=>({version:1,wallet:identity.wallet,claimsEnabled:true,currency:'SHARDS',status:'available',reason:null,cursor:null,nextCursor:null,rows:[{termId:id(3),termHash:command.termHash,startsAt:'2026-09-20T00:00:00.000Z',endsAt:'2026-09-27T00:00:00.000Z',spotId:0,winnerCount:2,poolTotal:'20',cumulativeTotal:'10',claimedTotal:'0',dueQuantity:'10'}]});
