import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildGlobePresentation } from './globe-presentation.mjs';
const source = path.resolve(process.env.PKW_NATIVE_SOURCE ?? '.source');
test('optional depth bytes retain canonical ocean interpolation across the dateline and poles', async () => {
  let bytes, effects;
  const presentation = await buildGlobePresentation({ source, readFile, addFile: async (file, value) => { if(file.endsWith(".rgba")) bytes = value; else effects = JSON.parse(value); } });
  const { width, height, stops, vectors } = presentation.ocean;
  assert.equal(bytes.length, width * height * 4);
  assert.equal(effects.length, 32);
  assert.ok(effects.every(site => site.shore.every(point => Number.isFinite(point.lon) && Number.isFinite(point.lat))));
  assert.deepEqual([...new Set(effects.flatMap(site => site.features.map(feature => feature.kind)))].sort(), ['beacon','fall','spore','vent']);
  assert.ok(effects.some(site => site.features.some(feature => feature.pixels.length > 0)), 'authored source pixels, not inferred feature locations');
  for (const { lon, lat, rgb } of vectors) {
    const u = (((lon + 180) % 360 + 360) % 360) / 360 * width - .5;
    const v = Math.max(0, Math.min(height - 1, (90 - lat) / 180 * height - .5));
    const x = Math.floor(u), y = Math.floor(v), fx = u - x, fy = v - y;
    const at = (x, y) => bytes.readFloatBE((Math.min(height - 1, y) * width + (x % width + width) % width) * 4);
    const depth = (at(x,y) * (1-fx) + at(x+1,y)*fx)*(1-fy) + (at(x,y+1)*(1-fx)+at(x+1,y+1)*fx)*fy;
    let a = stops[0], b = stops[1];
    for (let i = 1; i < stops.length; i++) { b = stops[i]; if (depth <= b[0]) break; a = b; }
    const t = a === b ? 0 : Math.max(0, Math.min(1, (depth-a[0])/(b[0]-a[0])));
    rgb.forEach((channel, index) => assert.ok(Math.abs(channel-(a[index+1]+(b[index+1]-a[index+1])*t)) < 1e-8));
  }
  assert.equal(presentation.islands.cell, 320);
  assert.deepEqual(presentation.clouds.banks, [[-120,42,9,4],[-110,36,8.5,3.8],[-117,32,8,3.6]]);
});
