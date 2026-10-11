import {SystemProgram} from '@solana/web3.js';
import {it,expect,vi} from 'vitest';
import {createCharterLockQuoteReader,buildCharterLockPacket,verifyCharterLockQuote} from './charterLockPreparation';
import {lockFixture} from './testFixtures/charterLock';
it('quotes one receipt and independently constructs a single leader set and clear packet',async()=>{
 for(const action of ['set','clear'] as const){const f=lockFixture(action),q=await createCharterLockQuoteReader(f.connect,f.options)(f.original,f.permitId);
 expect(q.costs.allocations).toHaveLength(1);expect(q.costs.allocations[0]!.bytes).toBe(107);expect(q.entryAuthorized).toBe(false);
 expect(verifyCharterLockQuote(JSON.parse(JSON.stringify(q)))).toEqual(q);
 expect(buildCharterLockPacket({...q.packetInput,policySignatureHex:f.sign(f.policy,Buffer.from(q.packetInput.candidateHex,'hex')).toString('hex')}).packetBytes).toBeLessThanOrEqual(1232);}
});
it.each(['revision','lock','owner','policy','pause','deployment','alt'] as const)('refuses %s before issuing a quote',async kind=>{
 const f=lockFixture();if(kind==='revision')f.get('charter').data.writeUInt32LE(2,153);if(kind==='lock')f.get('charter').data[158]=1;
 if(kind==='owner')f.get('asset').data[1]=f.get('asset').data[1]!^1;if(kind==='policy')f.authorityData[74]=f.authorityData[74]!^1;if(kind==='pause')f.authorityData[147]=1;
 if(kind==='deployment')f.rows[1]!.data[45]=f.rows[1]!.data[45]!^1;if(kind==='alt')f.lookup.data[21]=1;
 await expect(createCharterLockQuoteReader(f.connect,f.options)(f.original,f.permitId)).rejects.toThrow();
});
it('rejects changed quote economics, bank provenance and policy bytes rather than trusting retained JSON',async()=>{
 const f=lockFixture(),q=await createCharterLockQuoteReader(f.connect,f.options)(f.original,f.permitId);
 expect(()=>verifyCharterLockQuote({...q,costs:{...q.costs,totalLamports:'0'}})).toThrow();
 expect(()=>verifyCharterLockQuote({...q,observation:{...q.observation,lockKind:1}})).toThrow();
 expect(()=>verifyCharterLockQuote({...q,observation:{...q.observation,source:{...q.observation.source,accounts:q.observation.source.accounts.slice(1)}}})).toThrow();
 expect(()=>buildCharterLockPacket({...q.packetInput,policySignatureHex:'00'.repeat(64)})).toThrow();
 expect(()=>buildCharterLockPacket({...q.packetInput,original:{...q.packetInput.original,operation:{...q.packetInput.original.operation,action:'clear'}},policySignatureHex:null})).toThrow();
});
it('pins original terms and operator trust before asynchronous work',async()=>{
 const f=lockFixture(),read=createCharterLockQuoteReader(f.connect,f.options),original=structuredClone(f.original);let release!:(value:string)=>void;
 f.rpc.getGenesisHash=vi.fn().mockImplementationOnce(()=>new Promise<string>(r=>release=r)).mockResolvedValue(f.genesis.toBase58());
 const pending=read(original,f.permitId);while(!release)await Promise.resolve();(original.operation as {termsHash:string}).termsHash='aa'.repeat(32);(f.options.lookupTable as {dataSha256:string}).dataSha256='00'.repeat(32);release(f.genesis.toBase58());
 expect((await pending).packetInput.original.operation.termsHash).toBe(f.original.operation.termsHash);
});
it('retains pending capacity after ignored abort and performs no continuation RPC after timeout',async()=>{
 vi.useFakeTimers();try{const f=lockFixture(),read=createCharterLockQuoteReader(f.connect,f.options),releases:((value:string)=>void)[]=[];
 f.rpc.getGenesisHash=vi.fn(()=>new Promise<string>(r=>releases.push(r)));const pending=Array.from({length:8},()=>read(f.original,f.permitId).catch(e=>e));await vi.advanceTimersByTimeAsync(0);
 await vi.advanceTimersByTimeAsync(60000);expect((await Promise.all(pending)).every(e=>e.code==='DEADLINE')).toBe(true);await expect(read(f.original,f.permitId)).rejects.toMatchObject({code:'BUSY'});
 releases.forEach(r=>r(f.genesis.toBase58()));await vi.advanceTimersByTimeAsync(0);expect(f.rpc.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
 f.rpc.getGenesisHash=vi.fn(async()=>f.genesis.toBase58());expect((await read(f.original,f.permitId)).entryAuthorized).toBe(false);
 }finally{vi.useRealTimers();}
});

it('a prefunded empty System receipt remains eligible for normal Anchor initialization',async()=>{
 const f=lockFixture();f.rows.push({address:f.receipt,owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0)});
 expect(await createCharterLockQuoteReader(f.connect,f.options)(f.original,f.permitId)).toMatchObject({entryAuthorized:false,signingAuthorized:false});
});
