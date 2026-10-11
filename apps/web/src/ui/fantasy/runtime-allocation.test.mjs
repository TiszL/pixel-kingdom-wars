import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { mountClouds } from './runtime/clouds.mjs';
import { sampleOceanColor } from './runtime/ocean-detail.mjs';
import { RAD } from './runtime/world.mjs';

const digest = data => createHash('sha256').update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).digest('hex');
const canvasFixture = (width, height) => {
 const frames = [], ctx = {
  createImageData: vi.fn((w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })),
  clearRect: vi.fn(), putImageData: vi.fn(frame => frames.push({ frame, hash: digest(frame.data) })),
 };
 return { canvas: { width, height, getContext: () => ctx }, ctx, frames };
};

describe('reused globe pixels preserve accepted terrain and cloud appearance', () => {
 it('keeps exact ocean color bytes over poles and three longitude wraps while reusing caller output', () => {
  const colors = [], reused = [], out = new Float64Array(3);
  for (let lat = -90; lat <= 90; lat += 5) for (let lon = -540; lon <= 540; lon += 7.5) {
   colors.push(...sampleOceanColor(lon * RAD, lat * RAD));
   expect(sampleOceanColor(lon * RAD, lat * RAD, out)).toBe(out);
   reused.push(...out);
  }
  // Captured from the accepted allocation-heavy sampler before this optimization.
  const expected = 'aa77411025bc58af69e1d7da83f4ad383a286d385dc9cd07cc83b35e5299f4c5';
  expect(colors).toHaveLength(5365 * 3);
  expect(digest(Float64Array.from(colors))).toBe(expected);
  expect(digest(Float64Array.from(reused))).toBe(expected);
 });

 it('keeps standalone ocean calls independent and accepts ordinary caller-owned arrays', () => {
  const first = sampleOceanColor(0, 0), second = sampleOceanColor(0, 0), out = [];
  expect(first).not.toBe(second); expect(first).toEqual(second);
  expect(sampleOceanColor(0, 0, out)).toBe(out); expect(out).toEqual(second);
  first[0] = -1; expect(second[0]).toBeGreaterThan(0);
 });

 // Frame hashes captured before buffer reuse at overview, close terrain and deed zoom.
 // Comparing all moving frames also catches old opaque pixels left behind by a bank.
 it.each([
  [400, 400, 176, ['00182808db270af451e5ccf97507daf61270f31f817978fbea7687cbc9bcdd01', 'd662a14d189f4fa2050d042ed8c23f70eb0bc2621caec82d525ab81e22212d8b', 'b1ec0f4b0df831c3c9d23d3a5a89ea79556e5435f16d98dcb18f72458a2c11f7', '9b72d1e5d76bc4d91d06112432f2d143e042378021858b3be7bdfa8c6fd6096c']],
  [480, 240, 900, ['b27733b970bb81fb4d846ddc95dad0f69d62d197d911334cf84d0525311ec3b0', '23e43f5b23ef76c8f39fb1e050446586167207fe9fe17f271eb2fc5737f017fe', 'a9f6ae03ecc5f54fe3899c2078c5bb46bf056748ad07e465d61a71c360cd0946', 'cec29bb094d24241a1760972ec82da483f077ce31501283e1d72436514470ced']],
  [320, 500, 6600, ['6ff6df32609479757d4b0a3393259b3f734afe8d493959db9237249404cc8755', '6ff6df32609479757d4b0a3393259b3f734afe8d493959db9237249404cc8755', '95a2cbdcef642659bb98b12399e5cd2aeccb806ec4976111ed8b78ee3934a898', '22644567281071e227534b41d03b0e321b87d19f05dc850f9f9a0ef848f224cd']],
 ])('repaints exact moving cloud bytes at %i×%i, radius %i using one buffer', (width, height, radius, hashes) => {
  const { canvas, ctx, frames } = canvasFixture(width, height);
  const clouds = mountClouds({ canvas, getCamera: () => ({ lon: -115 * RAD, lat: 38 * RAD }), getRadius: () => radius });
  for (const time of [0, 50, 100, 200]) expect(clouds.draw(time, true)).toBe(true);
  expect(frames.map(frame => frame.hash)).toEqual(hashes);
  expect(new Set(frames.map(frame => frame.frame)).size).toBe(1);
  expect(ctx.createImageData).toHaveBeenCalledOnce(); clouds.dispose();
 });

 it('clears stale pixels, reallocates on equal-area rotation and stops using buffers after disposal', () => {
  const { canvas, ctx, frames } = canvasFixture(400, 240);
  let camera = { lon: -115 * RAD, lat: 38 * RAD };
  const clouds = mountClouds({ canvas, getCamera: () => camera, getRadius: () => 176 });
  clouds.setMotion(false); clouds.draw(0, true);
  const initial = frames[0].frame;
  initial.data.fill(255); // Previously painted pixels must never leak into the next view.
  clouds.draw(50, true); expect(frames[1].hash).toBe(frames[0].hash);
  expect(frames[1].frame).toBe(initial);
  canvas.width = 240; canvas.height = 400; clouds.draw(100, true);
  const rotated = frames[2].frame;
  expect(rotated).not.toBe(initial); expect([rotated.width, rotated.height]).toEqual([240, 400]);
  expect(ctx.createImageData).toHaveBeenCalledTimes(2);
  const fresh = canvasFixture(240, 400), reference = mountClouds({ canvas: fresh.canvas, getCamera: () => camera, getRadius: () => 176 });
  reference.setMotion(false); reference.draw(0, true);
  expect(frames[2].hash).toBe(fresh.frames[0].hash); reference.dispose();
  camera = { lon: 26 * RAD, lat: 23 * RAD };
  expect(clouds.draw(150, true)).toBe(false); expect(ctx.clearRect).toHaveBeenCalledOnce();
  camera = { lon: -115 * RAD, lat: 38 * RAD };
  clouds.draw(200, true); expect(frames.at(-1).frame).toBe(rotated);
  clouds.dispose(); expect(clouds.draw(250, true)).toBe(false);
  expect(ctx.createImageData).toHaveBeenCalledTimes(2);
 });
});

it('terrain retry replaces pending cloud banks and never publishes stale banks or errors',async()=>{
 const requests=[],onError=vi.fn(),{canvas,frames}=canvasFixture(400,400);
 const clouds=mountClouds({canvas,getCamera:()=>({lon:-115*RAD,lat:38*RAD}),getRadius:()=>176,read:()=>new Promise((resolve,reject)=>requests.push({resolve,reject})),onError});
 const retry=clouds.retry();expect(requests).toHaveLength(2);
 requests[0].reject(Error('old generation'));for(let i=0;i<8;i++)await Promise.resolve();
 expect(onError).not.toHaveBeenCalled();
 // Transparent accepted bank distinguishes the new authored source from fallback.
 requests[1].resolve({width:192,height:64,data:new Uint8ClampedArray(192*64*4)});await retry;
 clouds.draw(0,true);expect(frames[0].frame.data.every(value=>value===0)).toBe(true);
 await clouds.retry();expect(requests).toHaveLength(2);clouds.dispose();
});
