/** @vitest-environment happy-dom */
/**
 * A stale tab's failed chunk import is fixed by fetching the new bundle — and
 * ONLY by that, so the handler must reload once and then get out of the way:
 * reloading again on a chunk that is still missing after a fresh load would
 * spin the player forever.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./version', () => ({ reloadToLatest: vi.fn() }));

async function fresh(): Promise<typeof import('./preloadError')> {
  vi.resetModules();
  return import('./preloadError');
}

beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('handlePreloadError', () => {
  it('reloads on the first failure and refuses a second inside the loop window', async () => {
    const { handlePreloadError } = await fresh();
    const reload = vi.fn();
    let t = 1_000_000;
    expect(handlePreloadError(reload, () => t)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    t += 5_000;
    expect(handlePreloadError(reload, () => t)).toBe(false); // the reloaded page fails again
    expect(reload).toHaveBeenCalledTimes(1);
    t += 61_000;
    expect(handlePreloadError(reload, () => t)).toBe(true); // a later deploy is a new incident
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('survives a reload — the guard lives in sessionStorage, not module memory', async () => {
    const first = await fresh();
    const reload = vi.fn();
    expect(first.handlePreloadError(reload, () => 5_000_000)).toBe(true);
    const afterReload = await fresh();
    expect(afterReload.handlePreloadError(reload, () => 5_010_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads exactly once per page load when sessionStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private mode'); });
    const { handlePreloadError } = await fresh();
    const reload = vi.fn();
    expect(handlePreloadError(reload, () => 1)).toBe(true);
    expect(handlePreloadError(reload, () => 2)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('installPreloadErrorReload', () => {
  it('preserves the original preload rejection while reloading to the latest bundle', async () => {
    const mod = await fresh();
    const { reloadToLatest } = await import('./version');
    mod.installPreloadErrorReload();
    const e = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(e);
    // WHY: cancellation makes Vite fulfill the failed import with undefined.
    expect(e.defaultPrevented).toBe(false);
    expect(reloadToLatest).toHaveBeenCalledTimes(1);
  });
});

// Exercise the installed production seam: mocking import() alone misses Vite's
// cancelable event turning its catch handler into a fulfilled undefined value.
const require = createRequire(import.meta.url);
const vitePath = resolve(dirname(require.resolve('vite/package.json')), 'dist/node/chunks/node.js');
const viteSource = ts.createSourceFile(vitePath, readFileSync(vitePath, 'utf8'), ts.ScriptTarget.Latest, true);
const preloadNode = viteSource.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'preload');
if (!preloadNode) throw new Error('Installed Vite preload helper changed; recheck the recovery contract');
const installedReact = require(resolve(dirname(require.resolve('react')), 'cjs/react.production.js')) as {
  lazy(load: () => Promise<unknown>): { _payload: unknown; _init(payload: unknown): unknown };
};

it.each([
  { label: 'pending', guarded: false },
  { label: 'guarded', guarded: true },
])('keeps React lazy rejected when reload is $label', async ({ guarded }) => {
  const events = new EventTarget();
  vi.stubGlobal('window', events);
  const mod = await fresh();
  const reload = vi.fn(() => new Promise<void>(() => {}));
  if (guarded) mod.handlePreloadError(reload); // earlier load already started recovery
  reload.mockClear();
  mod.installPreloadErrorReload(reload);
  const preload = runInNewContext(`(${preloadNode!.getText(viteSource)})`, {
    window: events, Event, Promise, __VITE_IS_MODERN__: false,
  }) as (load: () => Promise<unknown>, dependencies: string[]) => Promise<unknown>;
  const original = new TypeError('Failed to fetch dynamically imported module: /assets/missing.js');
  const component = installedReact.lazy(() => preload(() => Promise.reject(original), []));
  let suspended: unknown;
  try { component._init(component._payload); } catch (reason) { suspended = reason; }
  await expect(suspended).rejects.toBe(original);
  expect(() => component._init(component._payload)).toThrow(original);
  expect(reload).toHaveBeenCalledTimes(guarded ? 0 : 1);
});
