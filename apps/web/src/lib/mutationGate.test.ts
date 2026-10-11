import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());

describe('document mutation gate', () => {
  it('closes synchronously once and cannot be reopened before reload', async () => {
    const { mutationGate } = await import('./mutationGate');
    const observed: boolean[] = [];
    mutationGate.subscribe(() => observed.push(mutationGate.getSnapshot()));
    expect(mutationGate.getSnapshot()).toBe(true);
    mutationGate.close();
    expect(observed).toEqual([false]);
    mutationGate.close();
    expect(observed).toEqual([false]);
    expect(mutationGate.getSnapshot()).toBe(false);
    expect(Object.isFrozen(mutationGate)).toBe(true);
    expect(Object.keys(mutationGate).sort()).toEqual(['close', 'getSnapshot', 'subscribe']);
  });

  it('unsubscribing removes observers without reopening the document', async () => {
    const { mutationGate } = await import('./mutationGate');
    const listener = vi.fn();
    const unsubscribe = mutationGate.subscribe(listener);
    unsubscribe(); unsubscribe(); mutationGate.close();
    expect(listener).not.toHaveBeenCalled();
    const unsubscribeAfterClose = mutationGate.subscribe(listener);
    unsubscribeAfterClose();
    expect(mutationGate.getSnapshot()).toBe(false);
  });
});
