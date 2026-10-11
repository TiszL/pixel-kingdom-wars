/**
 * Camp ruin rest cell (owner 2026-09-17: "camp destroyed state looks awful").
 *
 * WHY: the camp pack's collapse clip is a sink whose final cell is a sliver
 * of dirt. The generated ruin must (a) be an inlined PNG so it never enters
 * the on-demand loader or the first-paint budget, (b) share the pack's
 * 104×96 cell so the seat set from the collapse frame stays valid, and
 * (c) register exactly once per game even when two scenes race the async
 * decode — Phaser reports a second create as a key collision.
 */
import { describe, expect, it } from 'vitest';
import {
  WARE_RUIN_ART, ensureWareRuinTextures, wareRuinArt, wareRuinTexture,
} from './ruin';

function fakeScene(): { scene: { textures: unknown }; added: string[]; resident: Set<string> } {
  const resident = new Set<string>();
  const added: string[] = [];
  const textures = {
    exists: (key: string) => resident.has(key),
    addBase64: (key: string, _data: string) => { added.push(key); },
  };
  return { scene: { textures }, added, resident };
}

describe('ware ruin rest cells', () => {
  it('ships the camp ruin as an inlined 104×96 PNG matching the pack cell', () => {
    expect(WARE_RUIN_ART.camp?.key).toBe('ware_ruin_camp');
    const src = WARE_RUIN_ART.camp!.src;
    expect(src.startsWith('data:image/png;base64,')).toBe(true);
    const png = Buffer.from(src.slice('data:image/png;base64,'.length), 'base64');
    // IHDR: width at bytes 16..19, height at 20..23 (big-endian).
    expect(png.readUInt32BE(16)).toBe(104);
    expect(png.readUInt32BE(20)).toBe(96);
    expect(wareRuinArt('barracks')).toBeNull(); // real authored rubble stays authored
    expect(wareRuinArt('hasOwnProperty')).toBeNull();
  });

  it('registers each ruin once per TextureManager and reports it only once resident', () => {
    const a = fakeScene();
    ensureWareRuinTextures(a.scene as never);
    ensureWareRuinTextures(a.scene as never); // second scene / re-entry before onload
    expect(a.added).toEqual(['ware_ruin_camp']);
    expect(wareRuinTexture(a.scene as never, 'camp')).toBeNull(); // still decoding
    a.resident.add('ware_ruin_camp');
    expect(wareRuinTexture(a.scene as never, 'camp')).toBe('ware_ruin_camp');
    expect(wareRuinTexture(a.scene as never, 'mine')).toBeNull();
    ensureWareRuinTextures(a.scene as never);
    expect(a.added).toHaveLength(1);

    const b = fakeScene(); // a different game gets its own registration
    ensureWareRuinTextures(b.scene as never);
    expect(b.added).toEqual(['ware_ruin_camp']);
  });
});
