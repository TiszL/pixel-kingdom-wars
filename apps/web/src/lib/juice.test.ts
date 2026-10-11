import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';
import { flash } from './juice';

describe('flash', () => {
  it('uses the Phaser 4 fill-tint API and clears it after the hit-read frame', () => {
    let clear!: () => void;
    const victim = {
      active: true,
      setTint: vi.fn().mockReturnThis(),
      setTintMode: vi.fn().mockReturnThis(),
      clearTint: vi.fn(),
    };
    const scene = {
      time: { delayedCall: vi.fn((_ms: number, cb: () => void) => { clear = cb; }) },
    };

    flash(scene as never as Phaser.Scene, victim as never as Phaser.GameObjects.Sprite);

    expect(victim.setTint).toHaveBeenCalledWith(0xffffff);
    expect(victim.setTintMode).toHaveBeenCalledWith(1); // Phaser.TintModes.FILL
    expect(victim.clearTint).not.toHaveBeenCalled();
    clear();
    expect(victim.clearTint).toHaveBeenCalledOnce();
  });
});
