import { describe, expect, it, vi } from 'vitest';
import { BurnfieldFx, burnfieldFrames } from './burnfield';

const clips = {
  v2_fx_burnfield_t2: {
    frames: 4, rows: 1, cellW: 96, cellH: 64, fps: 5, anchorPx: [48, 34] as const,
  },
};

describe('burnfieldFrames', () => {
  it('pins the owner contract: live 1–2, extinguish 3–4, centre-ground anchor', () => {
    expect(burnfieldFrames(clips, 2)).toEqual({
      atlas: 'v2fx',
      live: ['v2_fx_burnfield_t2_f1', 'v2_fx_burnfield_t2_f2'],
      extinguish: ['v2_fx_burnfield_t2_f3', 'v2_fx_burnfield_t2_f4'],
      stepMs: 200,
      origin: [0.5, 34 / 64],
    });
    expect(burnfieldFrames(clips, 2, true)).toMatchObject({
      atlas: 'v2trp_direwyvern_t2_fx',
      live: ['v2_direwyvern_fx_burnfield_t2_f1', 'v2_direwyvern_fx_burnfield_t2_f2'],
    });
    expect(burnfieldFrames({}, 2)).toBeNull();
  });

  it('loops only while live, extinguishes once, and cancels every timer on cleanup', () => {
    const timers: Array<{ callback: () => void; remove: ReturnType<typeof vi.fn> }> = [];
    const sprite = {
      active: true,
      setOrigin: vi.fn().mockReturnThis(),
      setScale: vi.fn().mockReturnThis(),
      setDepth: vi.fn().mockReturnThis(),
      setTexture: vi.fn().mockReturnThis(),
      destroy: vi.fn(function (this: { active: boolean }) { this.active = false; }),
    };
    const timer = (callback: () => void) => {
      const t = { callback, remove: vi.fn() };
      timers.push(t);
      return t;
    };
    const scene = {
      textures: { exists: () => true },
      add: { image: vi.fn(() => sprite) },
      time: {
        addEvent: ({ callback }: { callback: () => void }) => timer(callback),
        delayedCall: (_delay: number, callback: () => void) => timer(callback),
      },
    };

    const fx = new BurnfieldFx(scene as never, clips, 2, 120, 240, 500);
    expect(fx.active).toBe(true);
    timers[0]!.callback();
    expect(sprite.setTexture).toHaveBeenLastCalledWith('v2fx', 'v2_fx_burnfield_t2_f2');
    timers[1]!.callback();
    expect(timers[0]!.remove).toHaveBeenCalledOnce();
    expect(sprite.setTexture).toHaveBeenLastCalledWith('v2fx', 'v2_fx_burnfield_t2_f3');
    timers[2]!.callback();
    expect(sprite.setTexture).toHaveBeenLastCalledWith('v2fx', 'v2_fx_burnfield_t2_f4');

    fx.destroy();
    expect(sprite.destroy).toHaveBeenCalledOnce();
    // The loop was cancelled at expiry and the still-pending final hold is
    // cancelled by destroy; timers whose callback already ran are complete.
    expect(timers[0]!.remove).toHaveBeenCalledOnce();
    expect(timers[3]!.remove).toHaveBeenCalledOnce();

    const beforeEarly = timers.length;
    const early = new BurnfieldFx(scene as never, clips, 2, 120, 240, 500);
    early.destroy();
    expect(timers.slice(beforeEarly).every((t) => t.remove.mock.calls.length > 0)).toBe(true);
  });
});
