import { CURRENT_LAYERED_REVISION_BY_REALM, currentBaseVisualForRealm, REALM_IDS } from '@shardkeep/shared/baseVisual';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../lib/events';
import { SceneGround } from './sceneGround';
import { LayeredGround } from './layeredGround';
import { RealmKitGround } from './realmKitGround';
import { FantasyGround } from './fantasyGround';

vi.mock('./layeredGround', () => ({ LayeredGround: { prepareContext: vi.fn() } }));
vi.mock('./realmKitGround', () => ({ RealmKitGround: { prepareContext: vi.fn(), preparePreview: vi.fn() } }));
vi.mock('./fantasyGround', () => ({ FantasyGround: vi.fn(class {
  diagnostics = { state: 'ready' }; set = vi.fn(); destroy = vi.fn();
  setCoverage = vi.fn(); styleDecor = vi.fn();
}) }));
vi.mock('../../lib/juice', () => ({ reduceMotionOn: () => false }));

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const context = (realmId = 'thornwake') => ({ version: 1, artVersion: 2, groundRevision: 3, realmId });
function fixture() {
  vi.stubGlobal('document', { hidden: false });
  // The dev preview switch reads the workspace .env (vite envDir); a developer's
  // local manifest map must not reroute these dispatch tests to the preview path.
  vi.stubEnv('VITE_REALM_KIT_PREVIEW_MANIFESTS', '');
  const events = new EventEmitter(), loading = vi.fn(), ready = vi.fn();
  const scene = { events, cameras: { main: { width: 390, height: 844, zoom: 0.25, scrollX: 10, scrollY: 20 } } };
  const ground = new SceneGround(scene as never, -34, 98, 64, loading, ready);
  const frame = () => events.emit('update', 16, 16);
  return { ground, scene, frame, loading, ready };
}
const layer = () => ({ update: vi.fn(), destroy: vi.fn() });
/** A prepared realm-kit ground: refuses to draw until it holds the server claim (REALM-KIT-PLAN §3). */
function kit() {
  const result = { claim: undefined as { min: number; max: number } | undefined,
    setClaim: vi.fn((claim?: { min: number; max: number }) => { result.claim = claim; }),
    update: vi.fn(() => { if (!result.claim) throw new Error('Realm kit needs the server claim'); }),
    obstacleSprite: vi.fn((spriteKey: string) => spriteKey === 'tree_old' ? { key: 'kit', frame: 0, origin: [0.5, 1], scale: 2 } : undefined),
    destroy: vi.fn() };
  return result;
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('actual scene ground revision dispatch', () => {
  it('keeps revision4 on the layered path and reveals it only after a valid draw', async () => {
    const next = layer(); vi.mocked(LayeredGround.prepareContext).mockResolvedValue(next as never);
    const { ground, frame } = fixture();
    const requested = { ...context(), groundRevision: 4 };
    try {
      ground.set(requested); await flush();
      expect(FantasyGround).not.toHaveBeenCalled();
      expect(vi.mocked(LayeredGround.prepareContext).mock.calls[0]?.[1]).toEqual(requested);
      expect(ground.diagnostics?.state).toBe('loading');
      frame(); expect(ground.diagnostics?.state).toBe('ready');
      ground.set(requested); expect(LayeredGround.prepareContext).toHaveBeenCalledOnce();
    } finally { ground.destroy(); }
  });
  it.each(REALM_IDS)('dispatches current %s to the realm kit (revision 5 since the owner flip of 2026-09-26) and reveals only after a valid first update', async realmId => {
    const next = kit(); vi.mocked(RealmKitGround.prepareContext).mockResolvedValue(next as never);
    const { ground, frame } = fixture();
    try {
      const current = currentBaseVisualForRealm(realmId);
      // Every realm presents the accepted kit (D-175, D-184): a current base must never be
      // routed to the r3/r4 layered painting or the legacy painted ground, and it draws only
      // once it holds the server claim (REALM-KIT-PLAN §3).
      expect(current).toEqual({ ...context(realmId), groundRevision: 5 });
      expect(CURRENT_LAYERED_REVISION_BY_REALM[realmId]).toBe(5);
      ground.setClaim({ min: 8, max: 22 });
      ground.set(current); await flush();
      expect(FantasyGround).not.toHaveBeenCalled(); expect(LayeredGround.prepareContext).not.toHaveBeenCalled();
      expect(vi.mocked(RealmKitGround.prepareContext).mock.calls[0]?.[1]).toEqual(current);
      expect(next.setClaim).toHaveBeenCalledWith({ min: 8, max: 22 });
      expect(ground.diagnostics?.state).toBe('loading');
      frame();
      expect(next.update).toHaveBeenCalledWith({ x: -575, y: -1246, width: 1560, height: 3376 }, 0, false);
      expect(ground.diagnostics?.state).toBe('ready');
      ground.set(current); expect(RealmKitGround.prepareContext).toHaveBeenCalledTimes(1);
    } finally { ground.destroy(); }
  });
  it('retains the previous ready layer during replacement and disposes cancelled late results', async () => {
    const a = layer(), b = layer(), c = layer(), pending = deferred<never>();
    vi.mocked(LayeredGround.prepareContext).mockResolvedValueOnce(a as never)
      .mockReturnValueOnce(pending.promise).mockResolvedValueOnce(c as never);
    const { ground, frame } = fixture();
    try {
      ground.set(context()); await flush(); frame();
      ground.set(context('frostveil')); expect(a.destroy).not.toHaveBeenCalled();
      const oldSignal = vi.mocked(LayeredGround.prepareContext).mock.calls[1]![3];
      ground.set(context('cinderfall')); await flush();
      expect(oldSignal.aborted).toBe(true); expect(a.destroy).not.toHaveBeenCalled();
      pending.resolve(b as never); await flush(); expect(b.destroy).toHaveBeenCalledOnce();
      frame(); expect(a.destroy).toHaveBeenCalledOnce(); expect(c.update).toHaveBeenCalled();
    } finally { ground.destroy(); }
  });
  it('relays bounded transfer progress only for the current realm, without publishing readiness before draw', async () => {
    const pending = deferred<never>(); vi.mocked(LayeredGround.prepareContext).mockReturnValue(pending.promise);
    const { ground } = fixture();
    try {
      ground.set(context());
      const report = vi.mocked(LayeredGround.prepareContext).mock.calls[0]![4]!;
      report({ phase: 'download', completed: 512, total: 2048 });
      expect(ground.diagnostics).toMatchObject({ state: 'loading', phase: 'download', completed: 512, total: 2048 });
      ground.set(context('frostveil'));
      report({ phase: 'ready', completed: 2048, total: 2048 });
      expect(ground.diagnostics).toMatchObject({ state: 'loading', phase: 'terrain', completed: 0 });
    } finally { ground.destroy(); pending.reject(new Error('aborted')); await flush(); }
  });
  it('keeps failed replacement recovery explicit and never discards the prior valid objects', async () => {
    const a = layer(), b = layer(); vi.mocked(LayeredGround.prepareContext)
      .mockResolvedValueOnce(a as never).mockRejectedValueOnce(new Error('hash mismatch')).mockResolvedValueOnce(b as never);
    const { ground, frame } = fixture();
    try {
      ground.set(context()); await flush(); frame(); ground.set(context('frostveil')); await flush();
      expect(ground.diagnostics).toMatchObject({ state: 'failed', error: 'hash mismatch' });
      expect(a.destroy).not.toHaveBeenCalled();
      ground.retryLoad(); await flush(); frame(); expect(ground.diagnostics?.state).toBe('ready');
      expect(a.destroy).toHaveBeenCalledOnce();
    } finally { ground.destroy(); }
  });
  it('does not advance decorations while the home scene sleeps beneath battle', async () => {
    const next = layer(); vi.mocked(LayeredGround.prepareContext).mockResolvedValue(next as never);
    const { ground, scene, frame } = fixture();
    try {
      ground.set(context()); await flush(); frame(); next.update.mockClear();
      scene.events.emit('sleep'); frame(); expect(next.update).not.toHaveBeenCalled();
      scene.events.emit('wake'); frame(); expect(next.update).toHaveBeenCalledOnce();
    } finally { ground.destroy(); }
    expect(scene.events.eventNames()).toEqual([]);
  });
  it('dispatches revision 5 to the realm kit, hands it the server claim and reveals it only after a valid draw', async () => {
    const next = kit(); vi.mocked(RealmKitGround.prepareContext).mockResolvedValue(next as never);
    const { ground, frame, ready } = fixture();
    const requested = { ...context('crownlands'), groundRevision: 5 };
    try {
      ground.setClaim({ min: 8, max: 22 });
      ground.set(requested); await flush();
      expect(FantasyGround).not.toHaveBeenCalled(); expect(LayeredGround.prepareContext).not.toHaveBeenCalled();
      expect(vi.mocked(RealmKitGround.prepareContext).mock.calls[0]?.[1]).toEqual(requested);
      expect(next.setClaim).toHaveBeenCalledWith({ min: 8, max: 22 });
      expect(ground.diagnostics?.state).toBe('loading'); expect(ready).not.toHaveBeenCalled();
      frame();
      expect(next.update).toHaveBeenCalledWith({ x: -575, y: -1246, width: 1560, height: 3376 }, 0, false);
      expect(ground.diagnostics?.state).toBe('ready'); expect(ready).toHaveBeenCalledOnce();
      // E-11: only the READY kit answers obstacle sheet lookups, and it is asked for the row's own
      // tile (a row seated on a kit prop draws that prop); a later claim reaches it too.
      expect(ground.obstacleSprite('tree_old', 'intact', 10, 10)).toEqual({ key: 'kit', frame: 0, origin: [0.5, 1], scale: 2 });
      expect(next.obstacleSprite).toHaveBeenCalledWith('tree_old', 'intact', 10, 10);
      expect(ground.obstacleSprite('bush', 'intact', 12, 12)).toBeUndefined();
      ground.setClaim({ min: 4, max: 26 }); expect(next.setClaim).toHaveBeenLastCalledWith({ min: 4, max: 26 });
      ground.set(requested); expect(RealmKitGround.prepareContext).toHaveBeenCalledOnce();
    } finally { ground.destroy(); }
  });
  it('routes only the realms named in the dev preview map through the switch, each to its own kit, so a local kit shows under a real base without a catalogue pin', async () => {
    const next = kit(); vi.mocked(RealmKitGround.preparePreview).mockResolvedValue(next as never);
    const other = layer(); vi.mocked(LayeredGround.prepareContext).mockResolvedValue(other as never);
    const { ground, frame, ready } = fixture();
    // One kit per realm under review (REALM-THEMES-PLAN §3 P0); spaces around entries are noise, not meaning.
    vi.stubEnv('VITE_REALM_KIT_PREVIEW_MANIFESTS', 'crownlands=/atlas/fantasy/layered-ground/abc/manifest.json, frostveil = /atlas/fantasy/layered-ground/def/manifest.json');
    try {
      ground.setClaim({ min: 8, max: 22 });
      ground.set({ ...context('crownlands'), groundRevision: 4 }); await flush();
      expect(vi.mocked(RealmKitGround.preparePreview).mock.calls[0]?.slice(1, 3)).toEqual(['/atlas/fantasy/layered-ground/abc/manifest.json', 64]);
      // The realm the entry was keyed by travels with the URL, so a mis-keyed manifest is refused downstream.
      expect(vi.mocked(RealmKitGround.preparePreview).mock.calls[0]?.[5]).toBe('crownlands');
      expect(LayeredGround.prepareContext).not.toHaveBeenCalled(); expect(RealmKitGround.prepareContext).not.toHaveBeenCalled();
      expect(next.setClaim).toHaveBeenCalledWith({ min: 8, max: 22 });
      frame(); expect(ground.diagnostics?.state).toBe('ready'); expect(ready).toHaveBeenCalledOnce();
      const frost = kit(); vi.mocked(RealmKitGround.preparePreview).mockResolvedValue(frost as never);
      ground.set({ ...context('frostveil'), groundRevision: 4 }); await flush();
      expect(vi.mocked(RealmKitGround.preparePreview).mock.calls[1]?.[1]).toBe('/atlas/fantasy/layered-ground/def/manifest.json');
      expect(vi.mocked(RealmKitGround.preparePreview).mock.calls[1]?.[5]).toBe('frostveil');
      // Every other realm keeps its published revision: the map previews the kits it names, it does not replace the catalogue.
      ground.set(context('thornwake')); await flush();
      expect(vi.mocked(LayeredGround.prepareContext).mock.calls[0]?.[1]).toEqual(context('thornwake'));
      expect(RealmKitGround.preparePreview).toHaveBeenCalledTimes(2);
    } finally { ground.destroy(); }
  });
  it('refuses a malformed dev preview map entry by name instead of previewing nothing, and ignores the map for archived painted contexts', () => {
    const { ground } = fixture();
    try {
      vi.stubEnv('VITE_REALM_KIT_PREVIEW_MANIFESTS', 'crownlands=/atlas/fantasy/layered-ground/abc/manifest.json,atlantis=/x');
      expect(() => ground.set({ ...context('crownlands'), groundRevision: 4 })).toThrow(/VITE_REALM_KIT_PREVIEW_MANIFESTS.*atlantis=\/x/);
      vi.stubEnv('VITE_REALM_KIT_PREVIEW_MANIFESTS', 'crownlands');
      expect(() => ground.set({ ...context('sunscar'), groundRevision: 4 })).toThrow(/VITE_REALM_KIT_PREVIEW_MANIFESTS/);
      // An artVersion-1 archive is a frozen painting; no kit previews it.
      vi.stubEnv('VITE_REALM_KIT_PREVIEW_MANIFESTS', 'frostveil=/atlas/fantasy/layered-ground/def/manifest.json');
      ground.set({ version: 1, artVersion: 1, realmId: 'frostveil' });
      expect(RealmKitGround.preparePreview).not.toHaveBeenCalled();
    } finally { ground.destroy(); }
  });
  it('is inert in production: with DEV false the manifest map is never read, so a value baked into a shipped build cannot reroute a realm off its catalogue pin or throw', async () => {
    const other = layer(); vi.mocked(LayeredGround.prepareContext).mockResolvedValue(other as never);
    const { ground, frame, ready } = fixture();
    // Vite replaces import.meta.env.DEV with false in production. The switch is NOT
    // tree-shaken (Rollup keeps the Map lookup and the class static in the lazy Phaser
    // chunk), so this runtime guard is all that stands between a stray build-time
    // variable and players; a malformed entry that throws under DEV must be ignored here.
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_REALM_KIT_PREVIEW_MANIFESTS', 'crownlands=/atlas/fantasy/layered-ground/abc/manifest.json,atlantis=/x');
    try {
      expect(() => ground.set({ ...context('crownlands'), groundRevision: 4 })).not.toThrow();
      await flush();
      expect(RealmKitGround.preparePreview).not.toHaveBeenCalled();
      expect(vi.mocked(LayeredGround.prepareContext).mock.calls[0]?.[1]).toEqual({ ...context('crownlands'), groundRevision: 4 });
      frame(); expect(ground.diagnostics?.state).toBe('ready'); expect(ready).toHaveBeenCalledOnce();
    } finally { ground.destroy(); }
  });
  it('fails loudly through diagnostics when a revision-5 context arrives without a claim, never guessing a plot', async () => {
    const next = kit(); vi.mocked(RealmKitGround.prepareContext).mockResolvedValue(next as never);
    const { ground, frame, ready } = fixture();
    try {
      ground.set({ ...context('crownlands'), groundRevision: 5 }); await flush(); frame();
      expect(ground.diagnostics).toMatchObject({ state: 'failed', error: 'Realm kit needs the server claim' });
      expect(next.destroy).toHaveBeenCalledOnce(); expect(ready).not.toHaveBeenCalled();
      expect(ground.obstacleSprite('tree_old', 'intact', 10, 10)).toBeUndefined();
      // Retry with the claim present succeeds through the same path.
      const again = kit(); vi.mocked(RealmKitGround.prepareContext).mockResolvedValue(again as never);
      ground.setClaim({ min: 8, max: 22 }); ground.retryLoad(); await flush(); frame();
      expect(ground.diagnostics?.state).toBe('ready'); expect(again.claim).toEqual({ min: 8, max: 22 });
    } finally { ground.destroy(); }
  });
  it('keeps revisions 3 and 4 on the painting path and never asks them for a claim or an obstacle sheet', async () => {
    const next = layer(); vi.mocked(LayeredGround.prepareContext).mockResolvedValue(next as never);
    const { ground, frame } = fixture();
    try {
      ground.setClaim({ min: 8, max: 22 });
      ground.set({ ...context(), groundRevision: 4 }); await flush(); frame();
      expect(RealmKitGround.prepareContext).not.toHaveBeenCalled();
      expect(ground.diagnostics?.state).toBe('ready');
      expect(ground.obstacleSprite('tree_old', 'intact', 10, 10)).toBeUndefined();
    } finally { ground.destroy(); }
  });
  it('reports a ground revision newer than this bundle and still paints the fallback without crashing', () => {
    // WHY: a stale tab met revision 5 before it knew the kit and silently painted old ground (the
    // owner's "old realms", 2026-09-26). The scene is the one place base and raid contexts land, so
    // it names the revision to UpdateGate and keeps drawing something valid meanwhile.
    const heard: number[] = [];
    const off = bus.on('scene:artworkOutdated', ({ groundRevision }) => heard.push(groundRevision));
    const { ground, frame } = fixture();
    try {
      const newer = { version: 1, artVersion: 2, realmId: 'frostveil', groundRevision: 6 };
      ground.set(newer);
      expect(heard).toEqual([6]);
      const paint = vi.mocked(FantasyGround).mock.results[0]!.value as FantasyGround;
      expect(paint.set).toHaveBeenCalledWith(newer);
      expect(RealmKitGround.prepareContext).not.toHaveBeenCalled(); expect(LayeredGround.prepareContext).not.toHaveBeenCalled();
      expect(() => frame()).not.toThrow();
      expect(ground.diagnostics?.state).toBe('ready');
      ground.retryLoad(); expect(heard).toEqual([6]); // a retry repaints the resolved fallback, not the server value
      // Every revision this bundle draws, including the current kit, stays silent.
      for (const groundRevision of [3, 4, 5]) ground.set({ ...newer, groundRevision });
      ground.set({ version: 1, artVersion: 1, realmId: 'frostveil' });
      expect(heard).toEqual([6]);
    } finally { off(); ground.destroy(); }
  });
  it('keeps archived painted contexts and passes their frozen values unchanged', () => {
    const { ground } = fixture();
    try {
      const archived = { version: 1, artVersion: 1, realmId: 'frostveil' };
      ground.set(archived);
      const paint = vi.mocked(FantasyGround).mock.results[0]!.value as FantasyGround;
      expect(paint.set).toHaveBeenCalledWith(archived);
      expect(LayeredGround.prepareContext).not.toHaveBeenCalled();
    } finally { ground.destroy(); }
  });
});
