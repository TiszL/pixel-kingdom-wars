import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./forge.css', import.meta.url), 'utf8');
const forge = source.slice(source.indexOf('function ForgeHero'), source.indexOf('/** Status pill'));

describe('Gold Forge authored hierarchy', () => {
  it('keeps shard deployment ahead of its statistics with quick picks and the payout projection', () => {
    const deploy = forge.indexOf('sk-forge-deploy');
    const today = forge.indexOf('sk-forge-today');
    expect(deploy).toBeGreaterThan(0);
    expect(today).toBeGreaterThan(deploy);
    expect(forge).toContain('25%');
    expect(forge).toContain('50%');
    expect(forge).toContain('MAX ·');
    expect(forge).toContain("PROJECTED AT TODAY'S POOL");
  });

  it('uses one comparison table and one shared-scale drop list, not chip/card walls', () => {
    expect(forge).toContain('sk-forge-trow sk-forge-trow--pour');
    expect(forge).toContain('(bps / maxDropBps) * 100');
    expect(forge).toContain('sk-forge-drop__pct');
    expect(forge).not.toContain('GLOBAL ALLOCATIONS');
  });

  it('plays the purpose-built eight-frame scene with CSS steps and no JS frame timer', () => {
    expect(forge).toContain('sk-forge-scene');
    expect(forge).not.toContain('setInterval(() => setTick');
    expect(forge).toContain("versionedPublicAsset('/brand/ui_forgescene.png')");
    expect(css).not.toContain("url('/brand/ui_forgescene.png')");
    expect(css).toContain('height: 200px');
    expect(css).toContain('steps(8)');
    expect(css).toContain('background-size: 2816px 216px');
  });

  it('keeps the handoff tab metrics and its single 900px layout collapse', () => {
    expect(forge).toContain('className="sk-forge-tabs"');
    expect(forge).toContain('className="interactive sk-forge-tab" aria-selected={tab === t}');
    expect(css).toContain('padding: 8px 12px 0');
    expect(css).toContain('padding: 5px 8px 7px');
    expect(css).toContain(".sk-forge-tab[aria-selected='true'] { border-color: #e3ae3c; background: #e3ae3c; color: #1a171e; }");
    expect(css).toContain('@media (max-width: 900px)');
    expect(css).not.toContain('@media (max-width: 480px)');
  });

  it('keeps the authored shards-in and KEEP-out story running for every built Forge', () => {
    expect(forge).toContain('const streaming = built && !reduceMotion;');
    expect(forge).not.toContain('built && smelting && !reduceMotion');
  });

  it('uses a house-palette pixel crucible and no platform emoji', () => {
    expect(forge).toContain('<PixelCrucible />');
    expect(forge).not.toContain('🔥');
    expect(forge).toContain("['..fF..', '.fFFf.', '..hh..', '.HHHH.', '.HggH.', '..HH..']");
  });

  it('keeps the server clock and multi-day claim contract intact', () => {
    expect(forge).toContain('useCountdownFrom(forge?.cycleEndsInSec)');
    expect(forge).toContain("recovery.controller?.review({ baseId: selectedBaseId ?? null, day: day ?? null })");
    expect(forge).not.toContain("'/forge/claim'");
    expect(forge).toContain('claimable.count');
    expect(forge).not.toContain('Date.now()');
  });
});
