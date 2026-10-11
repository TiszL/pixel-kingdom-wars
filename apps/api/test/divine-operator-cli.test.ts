/** CLI-only contract tests. Injected operator/session means no DB, RPC or funding
 * occurs here; divine-runtime.test.ts owns the real lifecycle acceptance. */
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PublicKey} from '@solana/web3.js';
import {afterEach,expect,it,vi} from 'vitest';
import {ORDINARY_REFINED_IDS} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {main,readDivineOperatorInput,DIVINE_OPERATOR_INPUT_BYTES,type DivineOperatorCliIo} from '../src/game/divineOperatorCli';
import {HttpError} from '../src/lib/errors';
const key=(byte:number)=>new PublicKey(Buffer.alloc(32,byte)).toBase58(),sponsor=key(1);
const env={NODE_ENV:'test',DATABASE_URL:'postgres://request:test@127.0.0.1:5433/shardkeep',PHASE_E_SERVICE_DATABASE_URL:'postgres://owner:test@127.0.0.1:5433/shardkeep',JWT_SECRET:'x'.repeat(32),WEB_ORIGIN:'http://localhost:5173',DIVINE_TRIAL_SPONSOR_WALLET:sponsor,
 MINING_CLAIM_PROGRAM_ID:key(2),MINING_CLAIM_DEPLOYMENT_SLOT:'1',MINING_CLAIM_PROGRAM_DATA_SHA256:'a'.repeat(64),GEMS_RESERVE_OWNER:key(3),HOT_WALLET_PUBKEY:key(4)};
function fixture(body:unknown){
 const operator={fundAndEnroll:vi.fn().mockResolvedValue({id:'funded-original'}),enroll:vi.fn().mockResolvedValue(undefined),closeAndSettle:vi.fn().mockResolvedValue({event:'closed-original',settlement:'saved-source'})},close=vi.fn().mockResolvedValue(undefined),openSession=vi.fn().mockResolvedValue({operator,close}),print=vi.fn(),printError=vi.fn(),readInput=vi.fn().mockResolvedValue(JSON.stringify(body));
 const io:DivineOperatorCliIo={openSession,print,printError,readInput};return {operator,close,openSession,print,printError,readInput,io};
}
const funding=()=>({sponsorWallet:sponsor,request:{id:randomUUID(),baseId:randomUUID(),weekStart:'2020-01-04T00:00:00.000Z',budget:Object.fromEntries(ORDINARY_REFINED_IDS.map(id=>[id,'1']))}});
const owned:string[]=[];afterEach(async()=>{await Promise.all(owned.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
it('dispatches only the named explicit command and closes its private session once',async()=>{
 for(const verb of ['fund-and-enroll','enroll','close-and-settle'] as const){const body=verb==='fund-and-enroll'?funding():{eventId:randomUUID()},f=fixture(body);
  expect(await main([verb,'--input','command.json'],env,f.io)).toBe(0);expect(f.openSession).toHaveBeenCalledTimes(1);expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.operator.fundAndEnroll).toHaveBeenCalledTimes(verb==='fund-and-enroll'?1:0);expect(f.operator.enroll).toHaveBeenCalledTimes(verb==='enroll'?1:0);expect(f.operator.closeAndSettle).toHaveBeenCalledTimes(verb==='close-and-settle'?1:0);
  if(verb==='fund-and-enroll')expect(f.operator.fundAndEnroll).toHaveBeenCalledWith(sponsor,(body as ReturnType<typeof funding>).request);else expect(verb==='enroll'?f.operator.enroll:f.operator.closeAndSettle).toHaveBeenCalledWith((body as {eventId:string}).eventId);
  expect(JSON.parse(f.print.mock.calls[0]![0]).command).toBe(verb);expect(f.printError).not.toHaveBeenCalled();
 }
});
it('rejects malformed invocations, unbounded or forged bodies before opening any source',async()=>{
 for(const args of [[],['fund-and-enroll'],['fund-and-enroll','--input','x','extra'],['show','--input','x'],['enroll','--input','x','--apply']]){const f=fixture(funding());expect(await main(args,env,f.io)).toBe(2);expect(f.readInput).not.toHaveBeenCalled();expect(f.openSession).not.toHaveBeenCalled();}
 const original=funding();for(const body of [{...original,domain:{}},{...original,request:{...original.request,clock:'2020-01-01'}},{...original,request:{...original.request,budget:{}}},{...original,request:{...original.request,id:original.request.id.toUpperCase()}},{eventId:randomUUID(),result:{stars:3}}]){const f=fixture(body);expect(await main(['fund-and-enroll','--input','x'],env,f.io)).toBe(2);expect(f.openSession).not.toHaveBeenCalled();}
 const huge=fixture({});huge.readInput.mockResolvedValue(' '.repeat(DIVINE_OPERATOR_INPUT_BYTES+1));expect(await main(['enroll','--input','x'],env,huge.io)).toBe(2);expect(huge.openSession).not.toHaveBeenCalled();
});
it('requires configured sponsor equality and private configuration before connections',async()=>{
 const f=fixture({...funding(),sponsorWallet:key(5)});expect(await main(['fund-and-enroll','--input','x'],env,f.io)).toBe(1);expect(f.openSession).not.toHaveBeenCalled();expect(f.printError.mock.calls[0]![0]).toContain('DIVINE_TRIAL_SPONSOR');
 const missing=fixture({eventId:randomUUID()});expect(await main(['enroll','--input','x'],{...env,PHASE_E_SERVICE_DATABASE_URL:''},missing.io)).toBe(1);expect(missing.openSession).not.toHaveBeenCalled();
});
it('retains exact command identity on refusal and never prints RPC/SQL credentials or source bodies',async()=>{
 const f=fixture(funding());f.operator.fundAndEnroll.mockRejectedValue(new HttpError(503,'private https://rpc.test/secret?api-key=key','DIVINE_FRAGMENT_DISABLED'));
 expect(await main(['fund-and-enroll','--input','x'],env,f.io)).toBe(1);expect(f.close).toHaveBeenCalledTimes(1);expect(f.operator.fundAndEnroll).toHaveBeenCalledTimes(1);expect(f.print).not.toHaveBeenCalled();expect(f.printError.mock.calls[0]![0]).toBe('DIVINE_FRAGMENT_DISABLED: command held; preserve the original command file');
 const failed=fixture({eventId:randomUUID()});failed.openSession.mockRejectedValue(Error('postgres://owner:secret@host/db'));
 expect(await main(['enroll','--input','x'],env,failed.io)).toBe(1);expect(failed.printError.mock.calls[0]![0]).not.toMatch(/postgres|secret|host/);expect(failed.close).not.toHaveBeenCalled();
 const cleanup=fixture({eventId:randomUUID()});cleanup.close.mockRejectedValue(Error('private-source-url'));
 expect(await main(['enroll','--input','x'],env,cleanup.io)).toBe(1);expect(cleanup.printError.mock.calls[0]![0]).not.toContain('private-source-url');
});
it('reads a bounded regular file and rejects larger files, directories, symlinks and malformed UTF-8',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shardkeep-divine-cli-'));owned.push(dir);const path=join(dir,'command.json'),body=JSON.stringify({eventId:randomUUID()});await writeFile(path,body);expect(await readDivineOperatorInput(path)).toBe(body);
 const link=join(dir,'link');await symlink(path,link);await expect(readDivineOperatorInput(link)).rejects.toThrow();await expect(readDivineOperatorInput(dir)).rejects.toThrow();
 await writeFile(path,' '.repeat(DIVINE_OPERATOR_INPUT_BYTES+1));await expect(readDivineOperatorInput(path)).rejects.toThrow();await writeFile(path,Buffer.from([0xc3,0x28]));await expect(readDivineOperatorInput(path)).rejects.toThrow();
});
