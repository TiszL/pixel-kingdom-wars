/** Candidate private service lifecycle; all database, source and service I/O is mocked. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { keepAta } from '@shardkeep/chain';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Db } from '../src/db/client';
import type { Config } from '../src/config';
const h = vi.hoisted(() => ({ createDb: vi.fn(), execute: vi.fn(), requestExecute: vi.fn(), end: vi.fn(),
  verifier: vi.fn(), verifierStart: vi.fn(), verifierClose: vi.fn(), job: vi.fn(), jobStart: vi.fn(), jobClose: vi.fn(), lastResult: vi.fn(), assertIdentity: vi.fn(), operator: vi.fn(), operatorRead: vi.fn(), operatorAbort: vi.fn() }));
vi.mock('../src/db/client', () => ({ createDb: h.createDb }));
vi.mock('../src/db/migrate', () => ({ assertMigrationsCurrent: async () => {} }));
vi.mock('../src/mining/publicationVerifierRuntime', () => ({ createMiningPublicationVerifierRuntime: h.verifier }));
vi.mock('../src/mining/publicationJob', () => ({ createMiningPublicationJob: h.job }));
vi.mock('../src/money/phaseEKeepIdentity', () => ({ assertPhaseEKeepIdentity: h.assertIdentity }));
vi.mock('../src/mining/publicationOperator', () => ({ createMiningPublicationOperator: h.operator }));
vi.mock('../src/mining/claimVerifierRuntime', () => ({ createMiningClaimVerifierRuntime: () => null }));
vi.mock('../src/seeker/realmSaleVerifierRuntime', () => ({ createRealmSaleVerifierRuntime: () => null }));
vi.mock('../src/mining/taxVerifierRuntime', () => ({ createMiningTaxVerifierRuntime: () => null }));
vi.mock('../src/game/divineRuntime', () => ({ createDivineRuntime: () => ({ deps: {}, operator: {} }) }));
vi.mock('../src/game/divineClanRuntime', () => ({ createDivineClanRuntime: () => ({ deps: {}, operator: {} }) }));
vi.mock('../src/game/boundCosmeticWakeViews', () => ({ createBoundCosmeticWakeViews: () => ({}) }));
vi.mock('../src/game/boundCosmeticWorkshop', () => ({ createBoundCosmeticWorkshop: () => ({}) }));
vi.mock('../src/game/boundCosmeticApplication', () => ({ boundCosmeticAwningApplicationReady: () => ({}) }));
vi.mock('../src/mining/claimStatus', () => ({ createMiningClaimReader: () => ({}) }));
vi.mock('../src/game/realmPassport', () => ({ createRealmPassportProvider: () => ({}) }));
vi.mock('../src/game/miningContributionRoutes', () => ({ createMiningContributionProvider: () => ({}) }));
vi.mock('../src/game/freeBasePurchaseRoutes', () => ({ createFreeBasePurchaseProvider: () => ({}) }));
vi.mock('../src/game/vehicleClient', () => ({ createVehicleClient: () => ({}) }));
vi.mock('../src/game/vehicleCraftClient', () => ({ createVehicleCraftClient: () => ({}) }));
vi.mock('../src/game/vehicleWorkflow', () => ({ createVehicleWorkflow: () => ({}) }));
vi.mock('../src/game/vehicleServiceWorkflow', () => ({ createVehicleServiceWorkflow: () => ({}) }));
vi.mock('../src/game/advancedFleetView', () => ({ createAdvancedFleetView: () => ({}) }));
vi.mock('../src/game/advancedExpeditionWorkflow', () => ({ createAdvancedExpeditionWorkflow: () => ({}) }));
vi.mock('../src/game/advancedExpeditionGameplay', () => ({ createAdvancedExpeditionGameplay: () => ({}) }));
vi.mock('../src/game/vehicleBerthOccupancy', () => ({ createVehicleBerthOccupancyProvider: () => ({}) }));
vi.mock('../src/game/clanCharterClient', () => ({ createClanCharterClient: () => ({}) }));
vi.mock('../src/game/clanCharterMigrationClient', () => ({ createClanCharterMigrationClient: () => ({}) }));
vi.mock('../src/game/clanCharterRetirementClient', () => ({ createClanCharterRetirementClient: () => ({}) }));
vi.mock('../src/db/charterSales', () => ({ createClanCharterSalesStore: () => ({}) }));
vi.mock('../src/game/seekerResourceClaimProvider', () => ({ createSeekerResourceClaimProvider: () => ({}) }));
vi.mock('../src/game/keepEquipmentMarketProvider', () => ({ createKeepEquipmentMarketProvider: () => ({}) }));
vi.mock('../src/game/starterExpeditionWorkflow', () => ({ createStarterExpeditionWorkflow: () => ({}) }));
vi.mock('../src/game/ordinaryEquipmentProvider', () => ({ createOrdinaryEquipmentProvider: () => ({}) }));
vi.mock('../src/mining/rosterEnrollmentGameplay', () => ({ createMiningRosterEnrollmentProvider: () => ({}) }));
vi.mock('../src/mining/shardsTaxMineRecoveryProvider', () => ({ createPhysicalMineRecoveryProvider: () => ({}) }));
import { createPhaseEServices, type PhaseEMiningPublicationSources } from '../src/phaseEServices';
const operator = new PublicKey('AvsebCwRDs63UMwKv2xSVCRKB8cxUS4W3B4sNR9SHpKv');
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const reserve = new PublicKey('CVKo5i8ax2kiKe9nSB4LfCpBEbyfaLcq8S8bWXsvKo1Q'), hot = key(7), gems = new PublicKey('GV1DHT162yYFfFeZh7yXcPyCYamMj7bmDa77tNTupMXb'), mint = key(9), program = new PublicKey('5qyN1Xbe2L16t7MPwwcD5QGmLYAnGF4VjN9BXtazvzkr');
const identity = { kind: 'keep-v4' as const, cluster: 'devnet' as const, genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  keepMint: mint.toBase58(), economyProgram: program.toBase58(), craftProgram: '4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59', treasury: '9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q',
  reserveOwner: reserve.toBase58(), reserveAta: keepAta(reserve,mint,true).toBase58(),
  bindingReceiptSha256: 'a'.repeat(64), economyDeployment: { reviewedDeploymentSlot: 42, reviewedProgramDataSha256: 'b'.repeat(64), upgradeAuthority: 'Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8' } };
const publicationTrust = () => ({ programId: program, keepMint: mint, reserveOwner: reserve, expectedGenesisHash: identity.genesisHash,
  reviewedDeploymentSlot: identity.economyDeployment.reviewedDeploymentSlot, reviewedProgramDataSha256: identity.economyDeployment.reviewedProgramDataSha256 });
const config = (patch: Partial<Config> = {}) => ({ DATABASE_URL: 'postgres://request:x@localhost:5433/example',
  PHASE_E_SERVICE_DATABASE_URL: 'postgres://owner:x@localhost:5433/example', SOLANA_CLUSTER: 'devnet',
  MINING_PUBLICATION_TESTER_STACK: 'true', PHASE_E_KEEP_IDENTITY: 'keep-v4', PHASE_E_KEEP_RESERVE_OWNER: reserve.toBase58(),
  HOT_WALLET_PUBKEY: hot.toBase58(), MINING_PUBLICATION_RECOVERY_ENABLED: 'false',
  MINING_PUBLICATION_JOB_ENABLED: 'false', ...patch } as Config);
const request = { execute: h.requestExecute } as unknown as Db;
const sources = () => ({ identity, verifierSources: { trust: publicationTrust(), receiptSource: vi.fn() }, job: { publisher: {}, sources: {},
  blockhashSource: vi.fn(), reconcile: { backing: { trust: publicationTrust() }, settlement: { trust: publicationTrust() } } } } as unknown as PhaseEMiningPublicationSources);
const open = (settings: Config, publication?: PhaseEMiningPublicationSources) => createPhaseEServices(settings, request,
  {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, publication);
beforeEach(() => {
  vi.resetAllMocks(); h.execute.mockResolvedValue([{ allowed: true }]); h.requestExecute.mockResolvedValue([{ allowed: true }]);
  h.end.mockResolvedValue(undefined); h.verifierClose.mockResolvedValue(undefined); h.jobClose.mockResolvedValue(undefined);
  h.createDb.mockReturnValue({ db: { execute: h.execute }, sql: { end: h.end } });
  h.verifier.mockResolvedValue({ start: h.verifierStart, close: h.verifierClose });
  h.job.mockReturnValue({ start: h.jobStart, close: h.jobClose, getLastResult: h.lastResult });
  h.assertIdentity.mockImplementation(async (_db, admitted) => admitted);
  h.operator.mockReturnValue({ read: h.operatorRead, abortProposed: h.operatorAbort });
});

describe('private mining publication mount', () => {
  it('does not construct publication runtimes with the rollout flags off', async () => {
    const service = (await open(config(), sources()))!; service.start(); await service.close();
    expect(h.verifier).not.toHaveBeenCalled(); expect(h.job).not.toHaveBeenCalled();
  });
  it('refuses enabled recovery without an actual private database or reviewed receipt connector before connection', async () => {
    await expect(open(config({ MINING_PUBLICATION_RECOVERY_ENABLED: 'true', PHASE_E_SERVICE_DATABASE_URL: undefined }), sources())).rejects.toThrow('private database');
    await expect(open(config({ MINING_PUBLICATION_RECOVERY_ENABLED: 'true' }))).rejects.toThrow('reviewed publication receipt');
    expect(h.createDb).not.toHaveBeenCalled();
  });
  it('refuses a forged enabled Config outside an explicit devnet tester stack', async () => {
    for (const patch of [{ SOLANA_CLUSTER: 'mainnet-beta' as const }, { MINING_PUBLICATION_TESTER_STACK: 'false' as const }]) {
      await expect(open(config({ MINING_PUBLICATION_RECOVERY_ENABLED: 'true', ...patch }), sources())).rejects.toThrow('devnet tester');
    }
    expect(h.createDb).not.toHaveBeenCalled();
  });
  it('refuses a job without the separately supplied application-owned publisher sources', async () => {
    const { job: _job, ...publication } = sources();
    await expect(open(config({ MINING_PUBLICATION_JOB_ENABLED: 'true', MINING_PUBLICATION_OPERATOR_PUBKEY: operator.toBase58() }),
      publication)).rejects.toThrow('application-owned publication publisher');
    expect(h.createDb).not.toHaveBeenCalled(); expect(h.job).not.toHaveBeenCalled();
  });
  it('keeps the publication capability out of AppDeps and starts/stops it exactly once', async () => {
    const publication = sources(), service = (await open(config({ MINING_PUBLICATION_RECOVERY_ENABLED: 'true' }), publication))!;
    expect(h.verifier).toHaveBeenCalledWith('postgres://owner:x@localhost:5433/example', publication.verifierSources, { enabled: true, cluster: 'devnet' });
    expect(service).not.toHaveProperty('publicationVerifier');
    expect(service.deps).not.toHaveProperty('publication'); expect(service.deps).not.toHaveProperty('publicationJob');
    service.start(); service.start(); expect(h.verifierStart).toHaveBeenCalledOnce();
    const firstClose = service.close(); expect(service.close()).toBe(firstClose); await firstClose;
    service.start(); expect(h.verifierStart).toHaveBeenCalledOnce(); expect(h.verifierClose).toHaveBeenCalledOnce();
    expect(h.end).toHaveBeenCalledOnce();
  });
  it('binds the job to the configured public operator, devnet and explicit tester gates', async () => {
    const publication = sources(), service = (await open(config({ MINING_PUBLICATION_JOB_ENABLED: 'true',
      MINING_PUBLICATION_OPERATOR_PUBKEY: operator.toBase58() }), publication))!;
    expect(h.job).toHaveBeenCalledWith(expect.anything(), { ...publication.job, enabled: true, testerStack: true,
      cluster: 'devnet', operator, hotWallet: hot });
    service.start(); expect(h.jobStart).toHaveBeenCalledOnce(); await service.close(); expect(h.jobClose).toHaveBeenCalledOnce();
  });
  it('checks the public role against publication and entitlement reads before mounting', async () => {
    h.requestExecute.mockResolvedValue([{ allowed: false }]);
    await expect(open(config({ MINING_PUBLICATION_RECOVERY_ENABLED: 'true' }), sources())).rejects.toThrow('not isolated');
    const query = new PgDialect().sqlToQuery(h.requestExecute.mock.calls[0]![0]).sql;
    expect(query).toContain("left(c.relname,19)='mining_publication_'");
    expect(query).toContain('entitlement_tables');
    expect(query).toContain('SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
    expect(h.verifier).not.toHaveBeenCalled(); expect(h.end).toHaveBeenCalledOnce();
  });
  it('preserves entitlement SELECT while rejecting entitlement ownership and writes in the role predicate', async () => {
    const service = (await open(config({ MINING_PUBLICATION_RECOVERY_ENABLED: 'true' }), sources()))!;
    const query = new PgDialect().sqlToQuery(h.requestExecute.mock.calls[0]![0]).sql;
    const entitlementCheck = query.slice(query.indexOf('or exists(select 1 from entitlement_tables'));
    expect(query).toContain("c.relname in ('mining_claim_entitlement_headers','mining_claim_entitlement_leaves')");
    expect(entitlementCheck).toContain('t.relowner=r.oid');
    expect(entitlementCheck).toContain("'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'");
    expect(entitlementCheck).toContain("'INSERT,UPDATE,REFERENCES'");
    expect(entitlementCheck).not.toContain("'SELECT,");
    await service.close();
  });
  it('drains a pending job before closing its pool even when another runtime close rejects', async () => {
    let finish!: () => void;
    h.jobClose.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    h.verifierClose.mockRejectedValue(Error('receipt connector close failed'));
    const service = (await open(config({ MINING_PUBLICATION_RECOVERY_ENABLED: 'true', MINING_PUBLICATION_JOB_ENABLED: 'true',
      MINING_PUBLICATION_OPERATOR_PUBKEY: operator.toBase58() }), sources()))!;
    const closing = service.close(), refusal = expect(closing).rejects.toThrow('private runtime shutdown failed');
    await Promise.resolve(); expect(h.end).not.toHaveBeenCalled(); finish(); await refusal;
    expect(h.end).toHaveBeenCalledOnce();
  });
  it('refuses missing, disabled or mismatched v4 identity before mounting any publication runtime', async () => {
    const settings = config({ MINING_PUBLICATION_RECOVERY_ENABLED: 'true' });
    for (const publication of [{ ...sources(), identity: undefined }, { ...sources(), identity: { ...identity, reserveOwner: gems.toBase58() } }]) {
      await expect(open(settings, publication as never)).rejects.toThrow('v4');
    }
    await expect(open({ ...settings, PHASE_E_KEEP_IDENTITY: 'disabled' }, sources())).rejects.toThrow('v4');
    expect(h.verifier).not.toHaveBeenCalled(); expect(h.job).not.toHaveBeenCalled();
  });
  it('compares the immutable stored identity before publication startup and never binds it', async () => {
    h.assertIdentity.mockRejectedValueOnce(Error('phase identity mismatch'));
    await expect(open(config({ MINING_PUBLICATION_RECOVERY_ENABLED: 'true' }), sources())).rejects.toThrow('phase identity mismatch');
    expect(h.assertIdentity).toHaveBeenCalledExactlyOnceWith(expect.anything(), identity);
    expect(h.verifier).not.toHaveBeenCalled(); expect(h.job).not.toHaveBeenCalled(); expect(h.end).toHaveBeenCalledOnce();
  });
  it('rejects a legacy Gems/v3 trust or any different reviewed publication pin', async () => {
    for (const trust of [{ ...publicationTrust(), reserveOwner: gems }, { ...publicationTrust(), keepMint: key(15) },
      { ...publicationTrust(), programId: key(16) }, { ...publicationTrust(), reviewedDeploymentSlot: 41 },
      { ...publicationTrust(), reviewedProgramDataSha256: 'c'.repeat(64) }, { ...publicationTrust(), expectedGenesisHash: key(17).toBase58() }]) {
      await expect(open(config({ MINING_PUBLICATION_RECOVERY_ENABLED: 'true' }), { ...sources(), verifierSources: { receiptSource: vi.fn(), trust } })).rejects.toThrow('publication identity');
    }
    expect(h.verifier).not.toHaveBeenCalled();
  });
  it('exposes the private job operator read surface with abort disabled when no authorization capability is supplied', async () => {
    const service = (await open(config({ MINING_PUBLICATION_JOB_ENABLED: 'true', MINING_PUBLICATION_OPERATOR_PUBKEY: operator.toBase58() }), sources()))!;
    expect(h.operator).toHaveBeenCalledWith(expect.anything(), { enabled: false, testerStack: true, cluster: 'devnet', operator,
      job: h.job.mock.results[0]!.value });
    expect(service.publicationOperator).toEqual({ read: h.operatorRead, abortProposed: h.operatorAbort });
    expect(service.deps).not.toHaveProperty('publicationOperator'); expect(h.operatorAbort).not.toHaveBeenCalled(); await service.close();
  });
  it('passes only an explicit application-owned authorization capability to the private operator', async () => {
    const authorizeAbort = vi.fn(async () => false), publication = { ...sources(), authorizeAbort };
    const service = (await open(config({ MINING_PUBLICATION_JOB_ENABLED: 'true', MINING_PUBLICATION_OPERATOR_PUBKEY: operator.toBase58() }), publication))!;
    expect(h.operator).toHaveBeenCalledWith(expect.anything(), { enabled: true, testerStack: true, cluster: 'devnet', operator,
      job: h.job.mock.results[0]!.value, authorizeAbort });
    expect(authorizeAbort).not.toHaveBeenCalled(); expect(h.operatorAbort).not.toHaveBeenCalled(); await service.close();
  });
  it('closes an already-created verifier and the private pool if job construction refuses', async () => {
    h.job.mockImplementation(() => { throw Error('publisher identity refused'); });
    await expect(open(config({ MINING_PUBLICATION_RECOVERY_ENABLED: 'true', MINING_PUBLICATION_JOB_ENABLED: 'true',
      MINING_PUBLICATION_OPERATOR_PUBKEY: operator.toBase58() }), sources())).rejects.toThrow('publisher identity refused');
    expect(h.verifierClose).toHaveBeenCalledOnce(); expect(h.end).toHaveBeenCalledOnce();
  });
});
