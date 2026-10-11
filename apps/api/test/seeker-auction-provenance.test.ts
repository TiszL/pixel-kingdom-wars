/** IS-S1 source label describes the admitted transport; it is not chain proof. */
import { expect,it } from 'vitest';
import { SeekerAuctionRoundViewSchema,SeekerAuctionSourcedRoundViewSchema } from '@shardkeep/shared/seekerAuctionApi';
import { readSeekerAuctionRound } from '../src/seeker/auctionReadModel';
import { createSeekerAuctionFixture,wallet } from '../../../packages/chain/src/testFixtures/seekerAuctionRead.fixture';
it('live read model emits chain only after finalized provenance validation',async()=>{
 const f=await createSeekerAuctionFixture(),result=await readSeekerAuctionRound(f.source,wallet.toBase58());
 expect(result.view.source).toBe('chain');expect(SeekerAuctionSourcedRoundViewSchema.parse(result.view)).toEqual(result.view);
 f.controls.failAccounts=true;await expect(readSeekerAuctionRound(f.source,wallet.toBase58())).rejects.toThrow();
});
it('sourced boundary refuses unlabeled/unknown source while allowing explicitly synthetic display DTOs',async()=>{
 const f=await createSeekerAuctionFixture(),view=(await readSeekerAuctionRound(f.source,wallet.toBase58())).view;
 const {source,...legacy}=view;
 expect(SeekerAuctionRoundViewSchema.safeParse(legacy).success).toBe(true);
 expect(SeekerAuctionSourcedRoundViewSchema.safeParse(legacy).success).toBe(false);
 expect(SeekerAuctionSourcedRoundViewSchema.safeParse({...view,source:'live'}).success).toBe(false);
 expect(SeekerAuctionSourcedRoundViewSchema.parse({...view,source:'fixture'}).source).toBe('fixture');
});

it('publishes finalized Clock and the canonical ATA amount, distinguishing an absent ATA from zero',async()=>{
 const f=await createSeekerAuctionFixture();
 expect((await readSeekerAuctionRound(f.source,wallet.toBase58())).view).toMatchObject({chainUnixTime:f.nowSec.toString(),walletSkrRaw:f.walletBalance.toString()});
 f.account(f.ata).data.writeBigUInt64LE(0n,64);
 expect((await readSeekerAuctionRound(f.source,wallet.toBase58())).view.walletSkrRaw).toBe('0');
 f.store.delete(f.ata.toBase58());
 expect((await readSeekerAuctionRound(f.source,wallet.toBase58())).view.walletSkrRaw).toBeNull();
});
