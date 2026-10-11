/**
 * GENERATED FILE — DO NOT EDIT. Regenerate with:
 *   pnpm --filter @shardkeep/scripts earth:mask
 * Generator: scripts/src/earth-mask.ts (records the full method + rationale).
 *
 * EARTH_COARSE: equirectangular land bitmask, 180×90 (2.00°).
 * Row 0 = north (lat +90), column 0 starts at lon −180. Bit `iy*cols + ix`, LSB-first.
 * 5432 land cells of 16200; cos-lat-weighted land fraction 29.1%
 * (raw cell fraction 33.5% — equirect over-weights the poles).
 *
 * SOURCE: https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/physical/ne_110m_land.json
 * LICENSE: Natural Earth vector data is PUBLIC DOMAIN
 * (https://www.naturalearthdata.com/about/terms-of-use/); the GeoJSON
 * conversion is CC0-1.0. No attribution required; recorded here anyway.
 *
 * LOADED EAGERLY, BUT NOT FROM index.ts. siteOf()/landSites() need this mask, so
 * it is a static import inside globe.ts rather than a dynamic one — but it is
 * reached ONLY at the subpath '@shardkeep/shared/earthMask' and is deliberately
 * absent from the barrel, because packages/sim imports the barrel and an
 * `export *` would put this base64 decode inside the deterministic replay graph
 * (index.ts's header states the rule; earthMask.test.ts and
 * packages/sim/tests/import-graph.test.ts assert both halves).
 */
import type { LandMask } from './globe';

const PACKED =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AOA/gP8BAAAAAAAAAAAAAAAAAAAAAAD4/////wcAAAAAAAAGAAAAAAAAAAAAgP/4//8PAPAAAAAA4AMAAAAAAAAAQADEh///' +
  '/wAAAAAACABgAAAAAAAAAABwUT8A/v8PAAAAAAwA/D8AOAAAAAAA8JPtA8D/fwAAAAAwIPz//wMDAACAAgD4w/4H+P8HAAAc' +
  'AAL7/////x8AgP///z+a8QD/HwAA+A8A9//////////w/////x9++B8AAOD/8//7////////jP////+/+AE/gAcA38//////' +
  '/////w/w/////wAc4AEAAHz+//////////9/gP////8HeAAcAADw5////////////ADgAf//f4AvAAAAAH78////////P0QA' +
  'AACA//8f8AcAAIBB4////////38ABwAAAPD//4//AQAAFAT/////////A3AAAAAA/P//+T8AAGDz//////////8DAwAAAMD/' +
  '////AwAAsP//////////LwAAAAAA+P///2EAAAD+//////////8CAAAAAAD///8/AAAA4P//////////BwAAAAAA8P///wcA' +
  'AAD+/+nz/////z8AAAAAAAD///8HAAAA/JgPPP//////MAAAAAAA8P//PwAAAOBH8v/n/////wcBAAAAAAD///8BAAAAPgD7' +
  'f/7///8xEAAAAAAA4P//DwAAAMBhAP/v////f8YAAAAAAAD8//8AAAAA+AcA//////8jDwAAAAAAgP//AwAAAMD/APD/////' +
  'PwgAAAAAAADw/x8AAAAA/n////////8HAAAAAAAAAPwDAwAAAOD////7////fwAAAAAAAACgHyAAAACA//9/f/7///8DAAAA' +
  'AAAAAPQBAAAAAPz///cv+v//HwAAAAAAAAAAHiAAAADA/////g////8EAAAAAAAAAOAhCAAAAPz//99/4D//AAAAAAAAAAAA' +
  'PAMGAADA/////Qf84BcAAAAAAAAAAAA/AAAAAPz//58fgAf+QAAAAAAAAAAAAA8AAADg////ewA4gA8EAAAAAAAAAADAAAAA' +
  'APz///8BgAP4AQAAAAAAAAAAAAgOAADA////bwAwgAwAAAAAAAAAAAAA8Q8AAPj///8HAAEIAAEAAAAAAAAAAID/AQAA////' +
  'fwBAAAEQAAAAAAAAAAAA+P8AAODh//8DAAA0GAAAAAAAAAAAAID/HwAAAPj/HwAAgMIBAAAAAAAAAAAA/P8BAACA//8AAAA4' +
  'HgAAAAAAAAAAAMD/fwAAAPz/BwAAAOMFAQAAAAAAAAAA/P8/AACA/z8AAABgTvABAAAAAAAAAOD//w8AAPD/AwAAAAQAfAAA' +
  'AAAAAAAA/P//AQAA/z8AAACAAoAPAAAAAAAAAID//w8AAPD/AwAAAAAAgAEAAAAAAAAA+P//AAAA/j8AAAAAAAAAAAAAAAAA' +
  'AAD//wcAAPD/QwAAAACAIwAAAAAAAAAA8P9/AAAA/z8EAAAAAD8GAAAAAAAAAAD8/wcAAPD/cQAAAAD4dwAAAAAAAAAAgP8/' +
  'AAAA/w8HAAAAgP8HAAAAAAAAAAD4/wMAAOD/MAAAAAD//wEAAAAAAAAAgP8fAAAA/g8DAAAA+P8fAAAAAAAAAAD4PwAAAOB/' +
  'EAAAAID//wMAAAAAAAAAwP8DAAAA/AMAAAAA+P9/AAAAAAAAAAD8HwAAAMA/AAAAAID//wcAAAAAAAAAwP8BAAAA+AEAAAAA' +
  '8P9/AAAAAAAAAAD8DwAAAIAPAAAAAAAP/gMAAAAAAAAAwB8AAAAAAAAAAAAAEIAfAAAAAAAAAAD+AQAAAAAAAAAAAAAA8AEg' +
  'AAAAAAAA4A8AAAAAAAAAAAAAAAAAAAYAAAAAAAA+AAAAAAAAAAAAAAAAgAAQAAAAAAAA4AMAAAAAAAAAAAAAAAAIgAEAAAAA' +
  'AAAeAAAAAAAAAAAAAAAAAAAMAAAAAAAA4AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAfAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAB4AOD53/8HAAAAAAAAAAAwAAAAAACA/P/h/////w8A' +
  'AAAAAAAA4AcAAAD4////z///////PwAAAAAAGAb8AACA//////////////8HAAD4/////wMAAP7/////////////HwAA+f//' +
  '//8BAID///////////////8AAPL/////BwAO////////////////DwAA+v////8HMPD//////////////z8AAOD/////////' +
  '////////////////P/A/+///////////////////////////////////////////////////////////////////////////' +
  '////////////';

// Base64 decoded by hand rather than with atob/Buffer: this module is imported
// by the browser bundle, the Fastify server AND vitest, and `atob` is a global
// that packages/shared does not declare in its `lib`. 12 lines removes the
// environment assumption entirely.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function unpack(s: string): Uint8Array {
  const pad = s.indexOf('=');
  const n = pad < 0 ? s.length : pad;
  const out = new Uint8Array((n * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < n; i++) {
    acc = (acc << 6) | B64.indexOf(s[i]!);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out;
}

export const EARTH_COARSE: LandMask = {
  cols: 180,
  rows: 90,
  bits: unpack(PACKED),
  landCells: 5432,
};
