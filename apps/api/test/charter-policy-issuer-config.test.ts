/** Temporary test-only keys and journals. No configured issuer is executed. */
import {createPublicKey,randomUUID,verify} from 'node:crypto';
import {chmod,link,mkdtemp,readFile,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Keypair} from '@solana/web3.js';
import {afterEach,expect,it,vi} from 'vitest';
import {loadCharterPolicyIssuerConfig,loadCharterPolicyIssuerSecrets,loadCharterIssuerJournalConfig} from '../src/charterPolicyIssuerConfig';
import {startCharterPolicyIssuer} from '../src/charterPolicyIssuerServer';
import {main as initialize} from '../src/charterPolicyIssuerInit';
import {openCharterIssuerJournal} from '../src/charterPolicyIssuerJournal';
import {createCharterPolicyIssuer} from '../src/charterPolicyIssuer';
import {createCharterWorkflowRpc} from '../src/game/charterWorkflowRpc';
import {createCharterPolicyIssuerService} from '../src/charterPolicyIssuerService';
import {CHARTER_ISSUER_HTTP} from '../src/charterPolicyIssuerClient';

const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
 const dir=await mkdtemp(path.join(tmpdir(),'charter-launcher-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
 const policy=Keypair.generate(),env:NodeJS.ProcessEnv={CHARTER_ISSUER_CLUSTER:'devnet',CHARTER_ISSUER_READ_RPC_URL:'https://issuer-rpc.example.invalid',CHARTER_ISSUER_CURRENT_PUBLIC_KEY:policy.publicKey.toBase58(),
  CHARTER_ISSUER_SECRET_KEY_FILE:path.join(dir,'key.json'),CHARTER_ISSUER_AUTH_TOKEN_FILE:path.join(dir,'token'),CHARTER_ISSUER_JOURNAL_FILE:path.join(dir,'journal'),CHARTER_ISSUER_STATE_PROVENANCE:'fresh-reviewed-deployment'};
 for(const family of ['ECONOMY','CRAFT','CORE']){env[`CHARTER_ISSUER_${family}_PROGRAM_ID`]=family==='CORE'?'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d':Keypair.generate().publicKey.toBase58();env[`CHARTER_ISSUER_${family}_DEPLOYMENT_SLOT`]='1';env[`CHARTER_ISSUER_${family}_PROGRAM_DATA_SHA256`]='ab'.repeat(32);env[`CHARTER_ISSUER_${family}_UPGRADE_AUTHORITY`]='none';}
 const token='test-token-'+randomUUID();await writeFile(env.CHARTER_ISSUER_SECRET_KEY_FILE!,JSON.stringify([...policy.secretKey]),{mode:0o600});await writeFile(env.CHARTER_ISSUER_AUTH_TOKEN_FILE!,token+'\n',{mode:0o600});
 return {dir,policy,env,token,config:loadCharterPolicyIssuerConfig(env)};
}
it('requires a complete dedicated immutable domain and never falls back to API or withdrawal settings',async()=>{
 const f=await fixture(),config=f.config;expect(config.host).toBe('127.0.0.1');expect(config.port).toBe(3004);expect(config.allowPrivateHttp).toBe(false);
 expect(Object.isFrozen(config.trust.economy)).toBe(true);const old=config.trust.economy.programId;f.env.CHARTER_ISSUER_ECONOMY_PROGRAM_ID=Keypair.generate().publicKey.toBase58();expect(config.trust.economy.programId).toBe(old);
 for(const key of ['CLUSTER','READ_RPC_URL','CURRENT_PUBLIC_KEY','SECRET_KEY_FILE','AUTH_TOKEN_FILE','JOURNAL_FILE','STATE_PROVENANCE',...['ECONOMY','CRAFT','CORE'].flatMap(family=>['PROGRAM_ID','DEPLOYMENT_SLOT','PROGRAM_DATA_SHA256','UPGRADE_AUTHORITY'].map(s=>family+'_'+s))]){
  const env:NodeJS.ProcessEnv={...f.env,SOLANA_RPC_URL:'https://api-fallback.invalid',WITHDRAWAL_POLICY_SIGNER_PUBLIC_KEY:f.policy.publicKey.toBase58()};delete env['CHARTER_ISSUER_'+key];expect(()=>loadCharterPolicyIssuerConfig(env),key).toThrow('CONFIGURATION');
 }
 for(const patch of [{CHARTER_ISSUER_CLUSTER:'testnet'},{CHARTER_ISSUER_ECONOMY_DEPLOYMENT_SLOT:'1.5'},{CHARTER_ISSUER_CORE_PROGRAM_ID:old},{CHARTER_ISSUER_CRAFT_PROGRAM_ID:f.env.CHARTER_ISSUER_ECONOMY_PROGRAM_ID},{CHARTER_ISSUER_SECRET_KEY_FILE:'relative'},{CHARTER_ISSUER_AUTH_TOKEN_FILE:config.secretKeyFile},{CHARTER_ISSUER_PORT:'0'}])expect(()=>loadCharterPolicyIssuerConfig({...f.env,...patch})).toThrow('CONFIGURATION');
});
it('requires explicit private HTTP opt-in and rejects public/plaintext or credential-bearing endpoints',async()=>{
 const f=await fixture();for(const url of ['http://127.0.0.1:8899','http://10.0.0.2:8899','http://[::1]:8899']){
  expect(()=>loadCharterPolicyIssuerConfig({...f.env,CHARTER_ISSUER_READ_RPC_URL:url})).toThrow('CONFIGURATION');
  expect(loadCharterPolicyIssuerConfig({...f.env,CHARTER_ISSUER_READ_RPC_URL:url,CHARTER_ISSUER_ALLOW_PRIVATE_HTTP:'true'}).readRpcUrl).toBe(new URL(url).href);
 }
 for(const url of ['http://8.8.8.8','http://issuer-rpc.example.invalid','https://user:secret@private.example','https://private.example/#fragment','https://api.devnet.solana.com'])expect(()=>loadCharterPolicyIssuerConfig({...f.env,CHARTER_ISSUER_READ_RPC_URL:url,CHARTER_ISSUER_ALLOW_PRIVATE_HTTP:'true'})).toThrow('CONFIGURATION');
 expect(()=>loadCharterPolicyIssuerConfig({...f.env,CHARTER_ISSUER_HOST:'0.0.0.0'})).toThrow('CONFIGURATION');expect(loadCharterPolicyIssuerConfig({...f.env,CHARTER_ISSUER_HOST:'0.0.0.0',CHARTER_ISSUER_ALLOW_PRIVATE_HTTP:'true'}).host).toBe('0.0.0.0');
 expect(()=>loadCharterPolicyIssuerConfig({...f.env,CHARTER_ISSUER_HOST:'8.8.8.8',CHARTER_ISSUER_ALLOW_PRIVATE_HTTP:'true'})).toThrow('CONFIGURATION');
});
it('loads an exact64-byte keypair into synchronous Ed25519 signing and disables the capability on close',async()=>{
 const f=await fixture(),secrets=await loadCharterPolicyIssuerSecrets(f.config);cleanup.push(async()=>secrets.close());
 expect(secrets.authToken).toBe(f.token);const message=Buffer.from('temporary-key-loader-test'),signature=secrets.signer.sign(message);expect(signature).toHaveLength(64);expect(signature).not.toBeInstanceOf(Promise);
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),f.policy.publicKey.toBuffer()]),format:'der',type:'spki'});expect(verify(null,message,key,signature)).toBe(true);
 secrets.close();expect(()=>secrets.signer.sign(message)).toThrow('CLOSED');
 await expect(loadCharterPolicyIssuerSecrets({...f.config,publicKey:Keypair.generate().publicKey.toBase58()})).rejects.toThrow('SECRET_FILE');
 const changed=[...f.policy.secretKey];changed[63]=changed[63]!^1;await writeFile(f.config.secretKeyFile,JSON.stringify(changed));await expect(loadCharterPolicyIssuerSecrets(f.config)).rejects.toThrow('SECRET_FILE');
});
it('refuses insecure, linked, nonregular, malformed and oversized secret files without disclosing content',async()=>{
 const f=await fixture();await chmod(f.config.secretKeyFile,0o644);await expect(loadCharterPolicyIssuerSecrets(f.config)).rejects.toThrow('SECRET_FILE');await chmod(f.config.secretKeyFile,0o600);
 const alias=path.join(f.dir,'alias');await symlink(f.config.secretKeyFile,alias);await expect(loadCharterPolicyIssuerSecrets({...f.config,secretKeyFile:alias})).rejects.toThrow('SECRET_FILE');await rm(alias);await link(f.config.secretKeyFile,alias);await expect(loadCharterPolicyIssuerSecrets(f.config)).rejects.toThrow('SECRET_FILE');await rm(alias);
 await expect(loadCharterPolicyIssuerSecrets({...f.config,secretKeyFile:f.dir})).rejects.toThrow('SECRET_FILE');
 for(const text of [JSON.stringify([...f.policy.secretKey].slice(1)),JSON.stringify([...f.policy.secretKey.slice(0,63),256]),'secret-content-not-json','x'.repeat(8193)]){await writeFile(f.config.secretKeyFile,text);await expect(loadCharterPolicyIssuerSecrets(f.config)).rejects.toThrow(/^Charter issuer refused: SECRET_FILE$/);}
 await writeFile(f.config.secretKeyFile,JSON.stringify([...f.policy.secretKey]));for(const token of ['short','a'.repeat(513),'a'.repeat(32)+'\n\n','secret token with spaces']){await writeFile(f.config.authTokenFile,token);await expect(loadCharterPolicyIssuerSecrets(f.config)).rejects.toThrow(/^Charter issuer refused: SECRET_FILE$/);}
});
it('initializes only through explicit offline command using domain settings, without loading a key or RPC',async()=>{
 const f=await fixture(),out:string[]=[],errors:string[]=[],io={print:(v:string)=>out.push(v),printError:(v:string)=>errors.push(v)},env={CHARTER_ISSUER_CLUSTER:'devnet',CHARTER_ISSUER_ECONOMY_PROGRAM_ID:f.config.domain.economyProgram,CHARTER_ISSUER_JOURNAL_FILE:f.config.journalFile};
 await rm(f.config.secretKeyFile);await rm(f.config.authTokenFile);const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('must not connect'));
 expect(await initialize([],env,io)).toBe(2);await expect(stat(f.config.journalFile)).rejects.toMatchObject({code:'ENOENT'});
 expect(await initialize(['initialize'],env,io)).toBe(0);expect(out).toEqual(['CHARTER_ISSUER_JOURNAL_INITIALIZED']);expect((await stat(f.config.journalFile)).mode&0o777).toBe(0o600);expect(JSON.parse((await readFile(f.config.journalFile,'utf8')).trim()).domain).toEqual(loadCharterIssuerJournalConfig(env).domain);
 expect(await initialize(['initialize'],env,io)).toBe(1);expect(errors.at(-1)).toBe('CHARTER_ISSUER_INIT_REFUSED');expect(fetch).not.toHaveBeenCalled();
});
it('server never initializes state and closes actual core/RPC/secrets after listen failure or shutdown',async()=>{
 const f=await fixture(),fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('no startup network'));
 await expect(startCharterPolicyIssuer(f.config)).rejects.toMatchObject({code:'STARTUP'});await expect(stat(f.config.journalFile)).rejects.toMatchObject({code:'ENOENT'});expect(fetch).not.toHaveBeenCalled();
 expect(await initialize(['initialize'],f.env,{print:()=>{},printError:()=>{}})).toBe(0);
 const occupied=createServer();await new Promise<void>(resolve=>occupied.listen(0,'127.0.0.1',resolve));cleanup.push(()=>new Promise<void>(resolve=>occupied.close(()=>resolve())));const port=(occupied.address() as {port:number}).port,config={...f.config,port};
 let rpcCloses=0,coreCloses=0,keyCloses=0;const caps:string[][]=[];
 const deps={loadSecrets:async(c:Parameters<typeof loadCharterPolicyIssuerSecrets>[0])=>{const s=await loadCharterPolicyIssuerSecrets(c);return {...s,close:()=>{keyCloses++;s.close();}};},
  createRpc:(input:Parameters<typeof createCharterWorkflowRpc>[0])=>{const r=createCharterWorkflowRpc(input);return {...r,close:()=>{rpcCloses++;r.close();}};},
  createIssuer:async(input:Parameters<typeof createCharterPolicyIssuer>[0])=>{caps.push(Object.keys(input.connect(new AbortController().signal)).sort());const issuer=await createCharterPolicyIssuer(input);return {...issuer,close:async()=>{coreCloses++;await issuer.close();}};},createService:createCharterPolicyIssuerService};
 await expect(startCharterPolicyIssuer(config,deps)).rejects.toMatchObject({code:'STARTUP'});expect([rpcCloses,coreCloses,keyCloses]).toEqual([1,1,1]);
 const journal=await openCharterIssuerJournal(config.journalFile,config.domain);await journal.close();await new Promise<void>(resolve=>occupied.close(()=>resolve()));
 const live=await startCharterPolicyIssuer(config,deps);cleanup.push(()=>live.close());const response=await live.app.inject({method:'POST',url:CHARTER_ISSUER_HTTP.lookupPath,headers:{authorization:'Bearer '+f.token},payload:{requestId:randomUUID()}});expect(response.statusCode,response.body).toBe(200);expect(response.json()).toBeNull();
 await live.close();await live.close();expect([rpcCloses,coreCloses,keyCloses]).toEqual([2,2,2]);expect(caps).toEqual(Array.from({length:2},()=>['getGenesisHash','getMultipleAccountsInfoAndContext','getSlot']));expect(fetch).not.toHaveBeenCalled();
 const released=await openCharterIssuerJournal(config.journalFile,config.domain);await released.close();
});
