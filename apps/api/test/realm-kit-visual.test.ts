/** Revision-5 realm-kit selection and the native downgrade (docs/REALM-KIT-PLAN.md
 * §6 step 3, E-12). WHY: the kit ships web-first behind a preview list, production
 * must keep stamping revision 4 until the owner approves, and an Android renderer
 * that predates contract 15 must see the published revision-4 realm — never the
 * artVersion-2 painting its own unknown-revision fallback would choose. */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { CURRENT_BASE_VISUAL, CURRENT_LAYERED_REVISION_BY_REALM, REALM_IDS, currentBaseVisualForRealm,
  resolveBaseVisualContext, type BaseVisualContext } from '@shardkeep/shared/baseVisual';
import { BASE_LAYERED_GROUND_V4 } from '@shardkeep/shared/layeredGroundCatalogue';
import { loadConfig } from '../src/config';
import { campaignBaseVisualHere, currentBaseVisualHere, realmKitPreviewRealms, resolveBaseVisual } from '../src/game/baseVisual';
import { registerGameRoutes } from '../src/game/routes';
import { nativeClientNeedsRealmKitDowngrade, nativeRendererContract, presentPayloadForClient,
  presentVisualContextForClient, registerNativeClientPresentation } from '../src/native/clientPresentation';
import { NATIVE_REALM_KIT_RENDERER_CONTRACT, NativeVisualContextSchema } from '../src/native/contracts';
import { ensureStartingBase } from '../src/game/base';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const priorPreview = process.env['REALM_KIT_PREVIEW_REALMS'];
const priorMulti = process.env['MULTI_BASE_ENABLED'];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  if (priorPreview === undefined) delete process.env['REALM_KIT_PREVIEW_REALMS']; else process.env['REALM_KIT_PREVIEW_REALMS'] = priorPreview;
  if (priorMulti === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = priorMulti;
  for (const app of apps.splice(0)) await app.close();
});
afterAll(async () => { await conn.sql.end(); });

const BASE_ENV = {
  DATABASE_URL: 'postgres://x:y@localhost:5433/example',
  JWT_SECRET: 'test-secret-test-secret-test-secret!',
  WEB_ORIGIN: 'http://localhost:5173',
  NODE_ENV: 'test',
};
const kit = (realmId: BaseVisualContext['realmId']): BaseVisualContext => ({ version: 1, realmId, artVersion: 2, groundRevision: 5 });
const r4 = (realmId: BaseVisualContext['realmId']): BaseVisualContext => ({ version: 1, realmId, artVersion: 2, groundRevision: 4 });
const android = (contract?: number | string) => ({ 'x-pkw-client': 'android-native',
  ...(contract === undefined ? {} : { 'x-pkw-renderer-contract': String(contract) }) });

describe('REALM_KIT_PREVIEW_REALMS selects revision 5 on this host only', () => {
  it('keeps the shared activation table (revision 5 everywhere since the owner flip of 2026-09-26) when unset — the production default', async () => {
    delete process.env['REALM_KIT_PREVIEW_REALMS'];
    expect(CURRENT_LAYERED_REVISION_BY_REALM.crownlands).toBe(5);
    for (const realmId of REALM_IDS) expect(currentBaseVisualHere(realmId)).toEqual(currentBaseVisualForRealm(realmId));
    expect(currentBaseVisualHere()).toEqual(CURRENT_BASE_VISUAL);
    expect(await resolveBaseVisual(db, null)).toEqual(CURRENT_BASE_VISUAL);
    expect(campaignBaseVisualHere(1)).toEqual(CURRENT_BASE_VISUAL);
  });

  it('lifts exactly the listed realms to revision 5 and leaves the others on their table row (now also 5, so the knob is a no-op for the revision)', async () => {
    process.env['REALM_KIT_PREVIEW_REALMS'] = ' crownlands, thornwake ';
    expect([...realmKitPreviewRealms()]).toEqual(['crownlands', 'thornwake']);
    expect(currentBaseVisualHere('crownlands')).toEqual(kit('crownlands'));
    expect(currentBaseVisualHere('thornwake')).toEqual(kit('thornwake'));
    // Since the flip the table row of an unlisted realm is revision 5 too; the knob may only select
    // preview descriptors, never lower a realm below the accepted revision.
    expect(currentBaseVisualHere('frostveil')).toEqual(kit('frostveil'));
    expect(currentBaseVisualHere('frostveil')).toEqual(currentBaseVisualForRealm('frostveil'));
    // The unplotted default, PvE camps and Crownlands campaign acts all follow.
    expect(await resolveBaseVisual(db, null)).toEqual(kit('crownlands'));
    expect(campaignBaseVisualHere(1)).toEqual(kit('crownlands'));
    expect(campaignBaseVisualHere(3)).toEqual(kit('elderwood'));
    // A previewed context is a valid, fully layered revision-5 context to every reader.
    expect(resolveBaseVisualContext(kit('crownlands'))).toEqual(kit('crownlands'));
    expect(NativeVisualContextSchema.safeParse(kit('crownlands')).success).toBe(true);
  });

  it('never rewrites a frozen context: resolution of a stored revision is not consulted against the preview', () => {
    process.env['REALM_KIT_PREVIEW_REALMS'] = 'crownlands';
    for (const frozen of [r4('crownlands'), { version: 1, realmId: 'crownlands', artVersion: 2, groundRevision: 3 },
      { version: 1, realmId: 'crownlands', artVersion: 2 }, { version: 1, realmId: 'crownlands', artVersion: 1 }] as const) {
      expect(resolveBaseVisualContext(frozen)).toEqual(frozen);
    }
  });

  it('fails loudly on an unknown realm id, at boot and at read', () => {
    expect(() => loadConfig({ ...BASE_ENV, REALM_KIT_PREVIEW_REALMS: 'crownlands,atlantis' })).toThrow();
    expect(loadConfig({ ...BASE_ENV, REALM_KIT_PREVIEW_REALMS: 'crownlands' }).REALM_KIT_PREVIEW_REALMS).toBe('crownlands');
    expect(loadConfig({ ...BASE_ENV, REALM_KIT_PREVIEW_REALMS: '' }).REALM_KIT_PREVIEW_REALMS).toBeUndefined();
    expect(() => realmKitPreviewRealms({ REALM_KIT_PREVIEW_REALMS: 'Crownlands' })).toThrow(/unknown realm/);
    expect([...realmKitPreviewRealms({})]).toEqual([]);
  });
});

describe('native renderers below the realm-kit contract are served revision 4 (E-12)', () => {
  it('reads the client and renderer-contract headers as a display-only signal', () => {
    expect(nativeRendererContract({})).toBeNull();
    expect(nativeRendererContract({ 'x-pkw-client': 'web' })).toBeNull();
    expect(nativeRendererContract({ 'x-pkw-renderer-contract': '15' })).toBeNull(); // not native: never downgraded
    expect(nativeRendererContract(android())).toBe(0); // every APK through contract 14 predates the header
    expect(nativeRendererContract(android(14))).toBe(14);
    expect(nativeRendererContract(android(15))).toBe(15);
    expect(nativeRendererContract(android('fifteen'))).toBe(0);
    expect(nativeRendererContract(android('-1'))).toBe(0);
    expect(nativeClientNeedsRealmKitDowngrade(android())).toBe(true);
    expect(nativeClientNeedsRealmKitDowngrade(android(NATIVE_REALM_KIT_RENDERER_CONTRACT - 1))).toBe(true);
    expect(nativeClientNeedsRealmKitDowngrade(android(NATIVE_REALM_KIT_RENDERER_CONTRACT))).toBe(false);
    expect(nativeClientNeedsRealmKitDowngrade({})).toBe(false);
  });

  it('downgrades only revision-5 contexts, only for old native renderers, to the published revision 4 of the same realm', () => {
    for (const realmId of REALM_IDS) {
      // The rewrite must always name published scenery: every realm has a pinned r4 descriptor.
      expect(BASE_LAYERED_GROUND_V4[realmId]?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(presentVisualContextForClient(kit(realmId), android())).toEqual(r4(realmId));
      expect(presentVisualContextForClient(kit(realmId), android(14))).toEqual(r4(realmId));
      expect(presentVisualContextForClient(kit(realmId), android(15))).toEqual(kit(realmId));
      expect(presentVisualContextForClient(kit(realmId), {})).toEqual(kit(realmId));
    }
    // Everything that is not the kit passes through by reference, old renderer or not.
    for (const untouched of [r4('crownlands'), { version: 1, realmId: 'sunscar', artVersion: 2, groundRevision: 3 },
      { version: 1, realmId: 'crownlands', artVersion: 2, groundRevision: 1 }, { version: 1, realmId: 'elderwood', artVersion: 2 },
      { version: 1, realmId: 'frostveil', artVersion: 1 }, undefined, null, 'garbage']) {
      expect(presentVisualContextForClient(untouched, android())).toBe(untouched);
    }
  });

  it('rewrites every DTO shape the clients read a visualContext from, copy-on-write', () => {
    const when = new Date('2026-09-21T00:00:00.000Z');
    const payload = {
      visualContext: kit('crownlands'), snapshot: { claimMin: 8, claimMax: 22, groundRevision: 5 },
      raid: { id: 'r', visualContext: kit('thornwake'), armySnapshot: { counts: {} } },
      raids: [{ id: 'a', visualContext: kit('sunscar') }, { id: 'b', visualContext: r4('sunscar') }],
      state: { visualContext: kit('elderwood'), clock: { serverNow: when } },
      events: [{ t: 0, e: 'x' }, { t: 1, e: 'y' }], bytes: Buffer.from('png'), createdAt: when,
    };
    const old = presentPayloadForClient(payload, android()) as typeof payload;
    expect(old).not.toBe(payload);
    expect(old.visualContext).toEqual(r4('crownlands'));
    expect(old.raid.visualContext).toEqual(r4('thornwake'));
    expect(old.raids.map((r) => r.visualContext)).toEqual([r4('sunscar'), r4('sunscar')]);
    expect(old.state.visualContext).toEqual(r4('elderwood'));
    // Untouched branches keep their identity: no snapshot, event, buffer or Date is copied or altered.
    expect(old.snapshot).toBe(payload.snapshot);
    expect(old.events).toBe(payload.events);
    expect(old.bytes).toBe(payload.bytes);
    expect(old.createdAt).toBe(when);
    expect(old.state.clock).toBe(payload.state.clock);
    expect(old.raids[1]).toBe(payload.raids[1]);
    expect(old.raid.armySnapshot).toBe(payload.raid.armySnapshot);
    expect(payload.visualContext).toEqual(kit('crownlands')); // the source object is never mutated
    // A current renderer and the web get the same reference back: zero cost, zero rewrite.
    expect(presentPayloadForClient(payload, android(15))).toBe(payload);
    expect(presentPayloadForClient(payload, {})).toBe(payload);
    expect(presentPayloadForClient({ raids: [{ visualContext: r4('sunscar') }] }, android())).toEqual({ raids: [{ visualContext: r4('sunscar') }] });
    for (const scalar of ['text', 7, null, undefined]) expect(presentPayloadForClient(scalar, android())).toBe(scalar);
  });

  it('serves GET /base at revision 4 to an old native renderer and at revision 5 to a current one', async () => {
    process.env['MULTI_BASE_ENABLED'] = 'false';
    process.env['REALM_KIT_PREVIEW_REALMS'] = 'crownlands';
    const p = await createTestPlayer(db);
    await ensureStartingBase(db, p.wallet);
    await ensureWalletBaseIdentity(db, p.wallet);
    const app = Fastify(); apps.push(app);
    app.decorateRequest('wallet', '');
    app.decorate('authenticate', async (req: { wallet: string }) => { req.wallet = p.wallet; });
    app.decorate('authenticateLoginRecovery', app.authenticate);
    app.decorate('requireLandOwned', async () => undefined);
    registerNativeClientPresentation(app);
    registerGameRoutes(app as never, db);
    await app.ready();
    const read = async (headers: Record<string, string>) => {
      const res = await app.inject({ method: 'GET', url: '/base', headers });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { visualContext: BaseVisualContext; obstacles: unknown[]; claim: { min: number; max: number } };
    };
    const web = await read({});
    expect(web.visualContext).toEqual(kit('crownlands'));
    expect((await read(android())).visualContext).toEqual(r4('crownlands'));
    expect((await read(android(14))).visualContext).toEqual(r4('crownlands'));
    const current = await read(android(NATIVE_REALM_KIT_RENDERER_CONTRACT));
    expect(current.visualContext).toEqual(kit('crownlands'));
    // The downgrade is presentation only: the rest of the payload is the same base.
    const old = await read(android());
    expect(old.claim).toEqual(web.claim);
    expect(old.obstacles).toEqual(web.obstacles);
  });
});
