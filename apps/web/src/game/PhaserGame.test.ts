import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./PhaserGame.tsx', import.meta.url), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the Phaser canvas behaves like a game surface on desktop', () => {
  it('suppresses the browser context menu after secondary gestures are rejected', () => {
    // Input guards prevent a right click from selecting or deploying, but
    // without this engine flag the browser menu still interrupts the canvas.
    expect(code).toMatch(/disableContextMenu\s*:\s*true/);
  });

  it('applies the tested render-rate policy through Phaser fps.limit', () => {
    expect(code).toMatch(/fps\s*:\s*\{\s*limit\s*:\s*fpsLimit\s*\}/);
    // Under that limit Phaser's counters still see every 120 Hz rAF. The
    // lightweight overlay must measure the rendered STEP callbacks instead.
    expect(code).toContain('timing.sample(time, game.loop.rawDelta, limited)');
    expect(code).toContain('timing.fps(limited ? 0 : game.loop.actualFps, limited)');
    expect(code).toContain('game.events.on(Phaser.Core.Events.PAUSE, onPause)');
    expect(code).toContain('game.events.off(Phaser.Core.Events.PAUSE, onPause)');
  });
});

describe('the Phaser canvas behaves like a game surface on a phone', () => {
  it('keeps Phaser touch capture so one physical tap never arrives as touch plus compat mouse', () => {
    // WHY: after a touch, browsers synthesise a compatibility mousedown/mouseup
    // at the same point. Phaser's TouchManager suppresses them by calling
    // preventDefault on the canvas touchstart while `capture` is on (its
    // default). Turning it off would hand BattleScene TWO pointer gestures for
    // one tap — two deploys — on exactly the devices the raid report came from.
    expect(code).not.toMatch(/touch\s*:\s*\{[^}]*capture\s*:\s*false/);
    expect(code).not.toMatch(/inputTouchCapture\s*:\s*false/);
  });
});
