/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FANTASY_ART_TIMEOUT_MS, MAX_FANTASY_DOWNLOAD_BYTES, loadFantasyPixels } from './art';
import manifest from './art-manifest.json';
import { BUILD } from '../../lib/version';

const spec=manifest.files[0]!;
const hash=Uint8Array.from(spec.sha256.match(/../g)!,byte=>parseInt(byte,16)).buffer;
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
let hidden=false;
const close=vi.fn(),drawImage=vi.fn();
const bitmap=()=>({width:spec.width,height:spec.height,close}) as unknown as ImageBitmap;
beforeEach(()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 hidden=false;vi.spyOn(document,'hidden','get').mockImplementation(()=>hidden);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([1]))));
 vi.spyOn(crypto.subtle,'digest').mockResolvedValue(hash);
 vi.stubGlobal('createImageBitmap',vi.fn(async()=>bitmap()));
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage,getImageData:()=>({data:new Uint8ClampedArray(4)})} as unknown as CanvasRenderingContext2D);
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();vi.clearAllMocks();});
const visibility=(value:boolean)=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));};
describe('verified globe art has a bounded foreground lifecycle',()=>{
 it('uses the exact client generation and closes decoded pixels with no surviving timer/listener',async()=>{
  const add=vi.spyOn(document,'addEventListener'),remove=vi.spyOn(document,'removeEventListener');
  expect(await loadFantasyPixels(spec.path)).toMatchObject({width:spec.width,height:spec.height});
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`/atlas/fantasy/globe/${spec.path}?v=${encodeURIComponent(BUILD.gitSha)}`,expect.objectContaining({cache:'default',signal:expect.any(AbortSignal)}));
  expect(close).toHaveBeenCalledOnce();expect(drawImage).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith('visibilitychange',add.mock.calls.find(call=>call[0]==='visibilitychange')![1]);
 });
 it('retains one same-generation reload for hash mismatch and never retries permanent HTTP failures',async()=>{
  vi.mocked(crypto.subtle.digest).mockResolvedValueOnce(new Uint8Array(32).buffer);
  await loadFantasyPixels(spec.path);
  expect(vi.mocked(fetch).mock.calls.map(call=>call[1]?.cache)).toEqual(['default','reload']);
  expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(vi.mocked(fetch).mock.calls[1]![0]);
  vi.mocked(fetch).mockClear().mockResolvedValueOnce(new Response(null,{status:404}));
  await expect(loadFantasyPixels(spec.path)).rejects.toThrow('Realm artwork: http');
  expect(fetch).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 });
 it.each(['fetch','body','verify','decode'] as const)('bounds a stalled %s and releases late bitmaps without painting',async(phase)=>{
  const delayed=deferred<ImageBitmap>();
  if(phase==='fetch')vi.mocked(fetch).mockImplementation(()=>new Promise(()=>{}));
  if(phase==='body')vi.mocked(fetch).mockResolvedValue({status:200,headers:new Headers(),body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:async()=>{}})}} as unknown as Response);
  if(phase==='verify')vi.mocked(crypto.subtle.digest).mockReturnValue(new Promise(()=>{}));
  if(phase==='decode')vi.mocked(createImageBitmap).mockReturnValue(delayed.promise);
  const result=loadFantasyPixels(spec.path).catch(error=>error);await flush();
  await vi.advanceTimersByTimeAsync(FANTASY_ART_TIMEOUT_MS);
  expect(await result).toMatchObject({message:phase==='decode'||phase==='verify'?`Terrain ${phase} timed out`:'Terrain preparation timed out'});
  if(phase==='fetch'||phase==='body')expect(vi.mocked(fetch).mock.calls[0]![1]?.signal?.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  if(phase==='decode'){delayed.resolve(bitmap());await flush();expect(close).toHaveBeenCalledOnce();}
  expect(drawImage).not.toHaveBeenCalled();
 });
 it('initial hidden time and duplicate visibility events never spend or renew the shared deadline',async()=>{
  hidden=true;vi.mocked(fetch).mockImplementation(()=>new Promise(()=>{}));
  let settled=false;const result=loadFantasyPixels(spec.path).catch(error=>{settled=true;return error;});
  await vi.advanceTimersByTimeAsync(90_000);expect(vi.getTimerCount()).toBe(0);expect(settled).toBe(false);
  visibility(false);await vi.advanceTimersByTimeAsync(20_000);visibility(false);
  visibility(true);await vi.advanceTimersByTimeAsync(90_000);visibility(true);expect(settled).toBe(false);
  visibility(false);await vi.advanceTimersByTimeAsync(FANTASY_ART_TIMEOUT_MS-20_001);expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);expect(await result).toMatchObject({message:'Terrain preparation timed out'});
 });
 it('allows slow headers and body within their independent foreground budgets',async()=>{
  const delayed=deferred<Response>();vi.mocked(fetch).mockReturnValue(delayed.promise);
  const result=loadFantasyPixels(spec.path);await vi.advanceTimersByTimeAsync(19_000);
  let body!:ReadableStreamDefaultController<Uint8Array>;
  delayed.resolve(new Response(new ReadableStream({start(value){body=value;}})));await flush();
  await vi.advanceTimersByTimeAsync(19_000);body.enqueue(new Uint8Array([1]));body.close();
  expect(await result).toMatchObject({width:spec.width});expect(vi.getTimerCount()).toBe(0);
 });
 it('keeps genuine byte progress alive beyond the former60s wall while retaining exact generation verification',async()=>{
  let body!:ReadableStreamDefaultController<Uint8Array>;
  vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({start(value){body=value;}}),{headers:{'content-length':'5',etag:'"globe"'}}));
  const result=loadFantasyPixels(spec.path);await flush();
  for(let i=0;i<5;i++){await vi.advanceTimersByTimeAsync(15_000);body.enqueue(new Uint8Array([i]));await flush();}
  body.close();expect(await result).toMatchObject({width:spec.width});
  expect(fetch).toHaveBeenCalledOnce();expect(crypto.subtle.digest).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  expect(vi.mocked(fetch).mock.calls[0]![1]).toMatchObject({headers:{'x-pkw-ground-stream':BUILD.gitSha},redirect:'error'});
 });
 it('still ends the finite visible episode when tiny chunks continue forever',async()=>{
  let body!:ReadableStreamDefaultController<Uint8Array>;
  vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({start(value){body=value;}})));
  const result=loadFantasyPixels(spec.path).catch(error=>error);await flush();
  for(let i=0;i<7;i++){await vi.advanceTimersByTimeAsync(15_000);body.enqueue(new Uint8Array([i]));await flush();}
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await result).toMatchObject({message:'Terrain preparation timed out'});expect(drawImage).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
 it('does not replenish the episode after a complete image fails integrity',async()=>{
  const bodies:ReadableStreamDefaultController<Uint8Array>[]=[];
  vi.mocked(fetch).mockImplementation(async()=>new Response(new ReadableStream({start(value){bodies.push(value);}})));
  vi.mocked(crypto.subtle.digest).mockResolvedValueOnce(new Uint8Array(32).buffer);
  const result=loadFantasyPixels(spec.path).catch(error=>error);await flush();
  for(let i=0;i<4;i++){await vi.advanceTimersByTimeAsync(15_000);bodies[0]!.enqueue(new Uint8Array([i]));await flush();}
  bodies[0]!.close();await flush();expect(fetch).toHaveBeenCalledTimes(2);
  for(let i=0;i<3;i++){await vi.advanceTimersByTimeAsync(15_000);bodies[1]!.enqueue(new Uint8Array([i]));await flush();}
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await result).toMatchObject({message:'Terrain preparation timed out'});expect(createImageBitmap).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
 it('retries transient unavailable responses within the same episode',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null,{status:503}));
  const result=loadFantasyPixels(spec.path);await vi.advanceTimersByTimeAsync(1_000);
  expect(await result).toMatchObject({width:spec.width});expect(fetch).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
 });
 it('bounds a real stalled byte stream to three idle attempts and never decodes it',async()=>{
  const cancel=vi.fn();vi.mocked(fetch).mockImplementation(async()=>new Response(new ReadableStream({cancel})));
  const result=loadFantasyPixels(spec.path).catch(error=>error);
  await vi.advanceTimersByTimeAsync(63_000);
  expect(await result).toMatchObject({reason:'idle-timeout'});expect(fetch).toHaveBeenCalledTimes(3);expect(cancel).toHaveBeenCalledTimes(3);
  expect(createImageBitmap).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
 it('resumes an interrupted same-generation image before its full SHA check',async()=>{
  let pulled=false;
  vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({pull(c){
   if(!pulled){pulled=true;c.enqueue(new Uint8Array([1,2]));}else c.error(new TypeError('offline'));
  }}),{headers:{etag:'"same"','content-length':'4'}})).mockResolvedValueOnce(new Response(new Uint8Array([3,4]),{
   status:206,headers:{etag:'"same"','content-range':'bytes 2-3/4','content-length':'2'},
  }));
  const result=loadFantasyPixels(spec.path);await vi.advanceTimersByTimeAsync(1_000);await result;
  expect(vi.mocked(fetch).mock.calls[1]![1]?.headers).toMatchObject({Range:'bytes=2-','If-Range':'"same"'});
  expect(crypto.subtle.digest).toHaveBeenCalledWith('SHA-256',new Uint8Array([1,2,3,4]));expect(close).toHaveBeenCalledOnce();
 });
 it('rejects two corrupt complete generations and a wrong bitmap size before painting',async()=>{
  vi.mocked(crypto.subtle.digest).mockResolvedValue(new Uint8Array(32).buffer);
  await expect(loadFantasyPixels(spec.path)).rejects.toThrow('Terrain integrity check failed');
  expect(fetch).toHaveBeenCalledTimes(2);expect(createImageBitmap).not.toHaveBeenCalled();
  vi.mocked(crypto.subtle.digest).mockResolvedValue(hash);
  vi.mocked(createImageBitmap).mockResolvedValue({...bitmap(),width:1});
  await expect(loadFantasyPixels(spec.path)).rejects.toThrow('Terrain dimensions changed');expect(close).toHaveBeenCalledOnce();expect(drawImage).not.toHaveBeenCalled();
 });
 it('supports the approved8,458,322-byte Solana image but rejects headers and streams above the globe ceiling',async()=>{
  const solana=manifest.files.find(file=>file.path==='generated/solana-detail.png')!;
  vi.mocked(crypto.subtle.digest).mockResolvedValue(Uint8Array.from(solana.sha256.match(/../g)!,byte=>parseInt(byte,16)).buffer);
  vi.mocked(createImageBitmap).mockResolvedValue({...bitmap(),width:solana.width,height:solana.height});
  vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array(8_458_322),{headers:{'content-length':'8458322'}}));
  await loadFantasyPixels(solana.path);expect(createImageBitmap).toHaveBeenCalledOnce();
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null,{headers:{'content-length':String(MAX_FANTASY_DOWNLOAD_BYTES+1)}}));
  await expect(loadFantasyPixels(spec.path)).rejects.toMatchObject({reason:'size'});
  vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array(MAX_FANTASY_DOWNLOAD_BYTES+1)));
  await expect(loadFantasyPixels(spec.path)).rejects.toMatchObject({reason:'size'});expect(createImageBitmap).toHaveBeenCalledOnce();
 });
 it('caller cancellation removes listeners and rejects immediately even when decode ignores abort',async()=>{
  const delayed=deferred<ImageBitmap>();vi.mocked(createImageBitmap).mockReturnValue(delayed.promise);
  const controller=new AbortController(),remove=vi.spyOn(document,'removeEventListener');
  const result=loadFantasyPixels(spec.path,controller.signal).catch(error=>error);await flush();controller.abort();
  expect(await result).toMatchObject({name:'AbortError'});expect(remove).toHaveBeenCalledWith('visibilitychange',expect.any(Function));
  delayed.resolve(bitmap());await flush();expect(close).toHaveBeenCalledOnce();expect(drawImage).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
 it('does not fetch a pre-aborted request and rejects unapproved paths without background work',async()=>{
  const controller=new AbortController();controller.abort();
  await expect(loadFantasyPixels(spec.path,controller.signal)).rejects.toMatchObject({name:'AbortError'});
  await expect(loadFantasyPixels('unapproved.png')).rejects.toThrow('Unknown fantasy terrain asset');
  expect(fetch).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
});
