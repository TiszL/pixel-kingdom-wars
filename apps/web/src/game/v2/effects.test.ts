import { describe, expect, it, vi } from 'vitest';
import { CombatEffectPool } from './effects';

function sceneHarness(): { scene: object; listeners: Map<string, (...args: number[]) => void> } {
  const listeners = new Map<string, (...args: number[]) => void>();
  return {
    scene: {
      events: {
        on: (name: string, cb: (...args: number[]) => void) => { listeners.set(name, cb); },
        once: vi.fn(),
        off: (name: string) => { listeners.delete(name); },
      },
    },
    listeners,
  };
}

describe('CombatEffectPool', () => {
  it('settles a complete cue exactly once even when a frame crosses its endpoint', () => {
    const { scene } = sceneHarness();
    const complete = vi.fn();
    const render = vi.fn();
    const pool = new CombatEffectPool(scene as never);
    pool.add(500, render, complete);
    pool.tick(700);
    pool.tick(700);
    expect(render).toHaveBeenLastCalledWith(500, 1);
    expect(complete).toHaveBeenCalledOnce();
    expect(pool.size).toBe(0);
  });

  it('uses one scene update listener for thousands of simultaneous effects', () => {
    const { scene, listeners } = sceneHarness();
    const pool = new CombatEffectPool(scene as never);
    const complete = vi.fn();
    for (let i = 0; i < 2_500; i++) pool.add(400, () => undefined, complete);
    expect(listeners.size).toBe(1);
    expect(pool.size).toBe(2_500);
    listeners.get('update')?.(0, 400);
    expect(complete).toHaveBeenCalledTimes(2_500);
    expect(pool.size).toBe(0);
  });

  it('disposes cancellation without inventing a completion', () => {
    const { scene } = sceneHarness();
    const complete = vi.fn();
    const dispose = vi.fn();
    const pool = new CombatEffectPool(scene as never);
    const handle = pool.add(100, () => undefined, complete, dispose);
    handle.cancel();
    pool.tick(100);
    expect(dispose).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it('advances raw-delta projectiles and streams on the playback catch-up scale', () => {
    const { scene, listeners } = sceneHarness();
    const pool = new CombatEffectPool(scene as never);
    const render = vi.fn();
    pool.add(800, render);
    pool.setTimeScale(8);
    listeners.get('update')?.(0, 50);
    expect(render).toHaveBeenLastCalledWith(400, 0.5);
  });

  it('clears every verdict-bound effect without applying presentation completions', () => {
    const { scene } = sceneHarness();
    const pool = new CombatEffectPool(scene as never);
    const complete = vi.fn();
    const dispose = vi.fn();
    pool.add(800, () => undefined, complete, dispose);
    pool.addLoop(() => undefined, dispose);
    pool.clear();
    expect(pool.size).toBe(0);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(complete).not.toHaveBeenCalled();
  });

  it('creates a fresh scheduler when a reusable Phaser scene restarts', async () => {
    const { scene } = sceneHarness();
    const { combatEffectPool } = await import('./effects');
    const first = combatEffectPool(scene as never);
    first.destroy();
    const second = combatEffectPool(scene as never);
    expect(second).not.toBe(first);
    expect(second.destroyed).toBe(false);
  });
});
