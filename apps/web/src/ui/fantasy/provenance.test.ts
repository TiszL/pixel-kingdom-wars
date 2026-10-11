import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifest from './art-manifest.json';
import { ARCHIPELAGOS,REGIONS,normalizedView,islandFocus } from './runtime/renderer.mjs';
const source=new URL('../../../../../art/fantasy-world-v1/globe/',import.meta.url);
describe('approved fantasy artwork provenance',()=>{
 it('pins the exact same23source images in generator and renderer',()=>{
  expect(JSON.parse(readFileSync(new URL('manifest.json',source),'utf8'))).toEqual(manifest);
  expect(manifest.files).toHaveLength(23);
  for(const file of manifest.files){const bytes=readFileSync(new URL(file.path,source));expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);expect(bytes.readUInt32BE(16)).toBe(file.width);expect(bytes.readUInt32BE(20)).toBe(file.height);}
 });
 it('retains all eight identities and32 permanently non-owned island destinations',()=>{
  expect(REGIONS.map(r=>r.id)).toEqual(['frostveil','elderwood','sunscar','crownlands','seeker-reach','stormcairn','thornwake','cinderfall']);
  expect(ARCHIPELAGOS).toHaveLength(7);expect(ARCHIPELAGOS.reduce((n,c)=>n+c.islands.length,0)).toBe(32);
  for(const chain of ARCHIPELAGOS)for(let i=1;i<=chain.islands.length;i++)expect(islandFocus(chain.id,`${chain.id}-${i}`)).not.toBeNull();
 });
 it('wraps rotations into the same world rather than reflecting continents',()=>{
  expect(normalizedView({lon:245,lat:38,zoom:3})).toEqual(normalizedView({lon:-115,lat:38,zoom:3}));
 });
 it('does not ship concept samples, simulated eligibility or demo battle state',()=>{
  const runtime=fileURLToPath(new URL('./runtime/',import.meta.url));
  for(const name of readdirSync(runtime).filter(n=>n.endsWith('.mjs'))){const code=readFileSync(`${runtime}/${name}`,'utf8');expect(code).not.toMatch(/SAMPLE_DEEDS|makeDemoProgress|eligibleFor\(|demoResult|DEMO-|sample-seeker/);}
 });
});
