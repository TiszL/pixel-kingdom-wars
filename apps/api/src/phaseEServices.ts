import {createBoundCosmeticWakeViews} from './game/boundCosmeticWakeViews';
import {createBoundCosmeticWorkshop} from './game/boundCosmeticWorkshop';
import {boundCosmeticAwningApplicationReady} from './game/boundCosmeticApplication';
/** Process-owned private services. The general request DB remains restricted;
 * these frozen capabilities expose wallet-scoped commands/history, never a Db,
 * a verifier writer, issuer key or caller-selected source. Admission gates stay
 * live inside each service; changing a flag cannot remove original recovery. */
import { sql } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import { miningConfigPda } from '@shardkeep/chain/mining-program';
import { createMiningClaimReader } from './mining/claimStatus';
import { createRealmPassportProvider } from './game/realmPassport';
import type { AppDeps } from './app';
import type { Config } from './config';
import { createDb, type Db } from './db/client';
import { assertMigrationsCurrent } from './db/migrate';
import { createMiningContributionProvider } from './game/miningContributionRoutes';
import { createFreeBasePurchaseProvider } from './game/freeBasePurchaseRoutes';
import { createVehicleClient } from './game/vehicleClient';
import { createVehicleCraftClient, type VehicleCraftClientDependencies } from './game/vehicleCraftClient';
import { createVehicleWorkflow } from './game/vehicleWorkflow';
import { createVehicleServiceWorkflow } from './game/vehicleServiceWorkflow';
import { createAdvancedFleetView } from './game/advancedFleetView';
import { createAdvancedExpeditionWorkflow } from './game/advancedExpeditionWorkflow';
import { createAdvancedExpeditionGameplay } from './game/advancedExpeditionGameplay';
import { createVehicleBerthOccupancyProvider } from './game/vehicleBerthOccupancy';
import { createClanCharterClient, type CharterClientOptions } from './game/clanCharterClient';
import { createClanCharterMigrationClient } from './game/clanCharterMigrationClient';
import type { CharterMigrationWorkflowOptions } from './game/clanCharterMigrationWorkflow';
import { createClanCharterRetirementClient, type CharterRetirementClientOptions } from './game/clanCharterRetirementClient';
import type { CharterTournamentsOptions } from './game/clanCharterTournaments';
import { createClanCharterSalesStore } from './db/charterSales';
import { createDivineClanRuntime } from './game/divineClanRuntime';
import { createSeekerResourceClaimProvider } from './game/seekerResourceClaimProvider';
import { createMiningClaimVerifierRuntime, type MiningClaimVerifierSources } from './mining/claimVerifierRuntime';
import { createRealmSaleVerifierRuntime, type RealmSaleVerifierSources } from './seeker/realmSaleVerifierRuntime';
import { createMiningTaxVerifierRuntime, type MiningTaxVerifierSources } from './mining/taxVerifierRuntime';
import type { CharterRecoverySource } from './game/clanCharterRecoveryRuntime';
import type { VehicleRuntimeSources } from './game/vehicleRuntime';
import { createKeepEquipmentMarketProvider } from './game/keepEquipmentMarketProvider';
import type { KeepEquipmentRuntimeSources } from './game/keepEquipmentRuntime';
import { createDivineRuntime } from './game/divineRuntime';
import type { MiningClaimsProvider } from './mining/claimRoutes';
import { createStarterExpeditionWorkflow } from './game/starterExpeditionWorkflow';
import { createOrdinaryEquipmentProvider } from './game/ordinaryEquipmentProvider';
import { createMiningRosterEnrollmentProvider } from './mining/rosterEnrollmentGameplay';
import { createPhysicalMineRecoveryProvider } from './mining/shardsTaxMineRecoveryProvider';
import type { SeekerGameplaySources } from './seeker/realmSaleRuntime';
import type { FinalizedDeedReader } from './game/baseOwnership';
import { createMiningPublicationVerifierRuntime, type MiningPublicationVerifierSources } from './mining/publicationVerifierRuntime';
import { createMiningPublicationJob, type MiningPublicationJobOptions } from './mining/publicationJob';
import { createMiningPublicationOperator, type MiningPublicationOperatorOptions } from './mining/publicationOperator';
import { assertPhaseEKeepIdentity, type PhaseEKeepIdentity } from './money/phaseEKeepIdentity';

/** Only the process composition root may supply these capabilities. No AppDeps
 * or request parameters expose publication preparation, signing or recovery. */
export interface PhaseEMiningPublicationSources {
  identity: PhaseEKeepIdentity;
  verifierSources?: MiningPublicationVerifierSources;
  job?: Omit<MiningPublicationJobOptions, 'enabled' | 'testerStack' | 'cluster' | 'operator' | 'hotWallet'>;
  authorizeAbort?: MiningPublicationOperatorOptions['authorizeAbort'];
}

type Ownership = { finalizedDeedReader?: FinalizedDeedReader | null; deedCollection?: string | null };
type ServiceDeps = Pick<AppDeps, 'miningContributionProvider' | 'freeBasePurchaseProvider'
  | 'vehicleCraftClientProvider' | 'vehicleClientProvider' | 'vehicleWorkflowProvider' | 'vehicleServiceWorkflowProvider'
  | 'advancedFleetViewProvider' | 'advancedExpeditionWorkflowProvider' | 'advancedExpeditionGameplay'
  | 'vehicleBerthOccupancyProvider' | 'charterClientProvider' | 'charterTournamentProvider'
  | 'charterTournamentEventsProvider' | 'charterRetirementClientProvider' | 'charterMigrationClientProvider' | 'seekerResourceClaimProvider'
  | 'boundCosmeticWakeViews' | 'boundCosmeticWorkshop' | 'ordinaryEquipment' | 'starterExpeditionWorkflow' | 'miningRosterEnrollmentProvider' | 'starterExpeditionProvider'
  | 'starterExpeditionAccessProvider' | 'harvesterProvider' | 'physicalMineSourceProvider' | 'physicalMineRecoveryProvider' | 'divineTrialProvider' | 'divineFragmentProvider' | 'realmPassportProvider' | 'keepEquipmentMarket'>;

export async function createPhaseEServices(config: Config, requestDb: Db, ownership: Ownership = {}, claimReceipts?: MiningClaimVerifierSources,
  realmSaleReceipts?: RealmSaleVerifierSources, taxReceipts?: MiningTaxVerifierSources, vehicleSources?: VehicleRuntimeSources,
  seekerSources?: SeekerGameplaySources, charterRecovery?: CharterRecoverySource, divineQualification?: Pick<MiningClaimsProvider, 'reader' | 'trust'>, keepMarketSources?: KeepEquipmentRuntimeSources, charterTournaments?: CharterTournamentsOptions, charterClient?: CharterClientOptions, charterRetirement?: CharterRetirementClientOptions, charterMigration?: CharterMigrationWorkflowOptions, vehicleCraftRecovery?: Pick<VehicleCraftClientDependencies, 'readFinalizedResult' | 'readFinalizedMint'>, publication?: PhaseEMiningPublicationSources) {
  const publicationRecoveryEnabled = config.MINING_PUBLICATION_RECOVERY_ENABLED === 'true';
  const publicationJobEnabled = config.MINING_PUBLICATION_JOB_ENABLED === 'true';
  if (publicationRecoveryEnabled || publicationJobEnabled) {
    if (config.SOLANA_CLUSTER !== 'devnet' || config.MINING_PUBLICATION_TESTER_STACK !== 'true') {
      throw new Error('Mining publication requires an explicit devnet tester stack');
    }
    if (!config.PHASE_E_SERVICE_DATABASE_URL) throw new Error('Mining publication requires a private database');
    if (publicationRecoveryEnabled && !publication?.verifierSources) throw new Error('Missing reviewed publication receipt sources');
    if (publicationJobEnabled && (!publication?.job || !config.MINING_PUBLICATION_OPERATOR_PUBKEY)) {
      throw new Error('Missing application-owned publication publisher sources and operator public identity');
    }
    if (config.PHASE_E_KEEP_IDENTITY !== 'keep-v4' || !publication?.identity || publication.identity.kind !== 'keep-v4'
        || publication.identity.cluster !== 'devnet' || publication.identity.reserveOwner !== config.PHASE_E_KEEP_RESERVE_OWNER
        || config.PHASE_E_KEEP_RESERVE_OWNER !== 'CVKo5i8ax2kiKe9nSB4LfCpBEbyfaLcq8S8bWXsvKo1Q'
        || !config.HOT_WALLET_PUBKEY) throw new Error('Mining publication requires the reviewed KEEP v4 identity');
  }
  if (!config.PHASE_E_SERVICE_DATABASE_URL) return null;
  const requestUrl = new URL(config.DATABASE_URL), serviceUrl = new URL(config.PHASE_E_SERVICE_DATABASE_URL);
  // A second pool must address the same database with a different LOGIN, not a
  // similarly configured clone or the public role wearing an owner capability.
  if (!['postgres:', 'postgresql:'].includes(serviceUrl.protocol)
      || requestUrl.hostname !== serviceUrl.hostname
      || (requestUrl.port || '5432') !== (serviceUrl.port || '5432')
      || requestUrl.pathname !== serviceUrl.pathname || requestUrl.username === serviceUrl.username) {
    throw new Error('Phase E services require the same database and a separate private LOGIN');
  }
  const connection = createDb(serviceUrl.toString(), { max: 4, connectTimeoutSeconds: 5 });
  let verifier: Awaited<ReturnType<typeof createMiningClaimVerifierRuntime>> | null = null;
  let realmSaleVerifier: Awaited<ReturnType<typeof createRealmSaleVerifierRuntime>> | null = null;
  let taxVerifier: Awaited<ReturnType<typeof createMiningTaxVerifierRuntime>> | null = null;
  let publicationVerifier: Awaited<ReturnType<typeof createMiningPublicationVerifierRuntime>> | null = null;
  let publicationJob: ReturnType<typeof createMiningPublicationJob> | null = null;
  try {
    await assertMigrationsCurrent(connection.db);
    const [owner] = await connection.db.execute<{ allowed: boolean }>(sql`select current_user=session_user
      and not exists(select 1 from pg_class where oid in (
        'public.mining_contribution_receipts'::regclass,'public.mining_free_base_purchases'::regclass,
        'public.mining_publication_attempts'::regclass,'public.mining_publication_manifests'::regclass,
        'public.mining_publication_signing_reservations'::regclass,'public.mining_publication_signed_wires'::regclass,
        'public.mining_publication_settlements'::regclass,'public.mining_claim_entitlement_headers'::regclass,
        'public.mining_claim_entitlement_leaves'::regclass,
        'public.vehicle_activation_reservations'::regclass,'public.charter_creation_reservations'::regclass,
        'public.advanced_expeditions'::regclass,'public.ordinary_equipment_jobs'::regclass,
        'public.ordinary_crafting_jobs'::regclass,'public.bound_cosmetic_jobs'::regclass,
        'public.bound_cosmetic_preferences'::regclass,'public.bound_cosmetic_raid_visuals'::regclass,
        'public.mining_roster_baselines'::regclass,'public.divine_trial_events'::regclass,
        'public.divine_fragment_enrollments'::regclass,'public.seeker_fragment_claims'::regclass,'public.keep_equipment_payment_preparations'::regclass) and relowner<>current_user::regrole::oid) allowed`);
    const [request] = await requestDb.execute<{ allowed: boolean }>(sql`with private_tables as (
      select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and (
        c.relname in ('mining_contribution_receipts','mining_free_base_purchases')
        or left(c.relname,19)='mining_publication_'
        or left(c.relname,8)='charter_' or left(c.relname,13)='clan_charter_'
        or left(c.relname,8)='vehicle_' or left(c.relname,9)='advanced_'
        or left(c.relname,15)='keep_equipment_' or c.relname='payment_signature_claims'
        or left(c.relname,13)='divine_trial_' or left(c.relname,16)='divine_fragment_'
        or c.relname in ('crystal_fragment_stocks','seeker_fragment_claims')
        or left(c.relname,19)='ordinary_equipment_' or left(c.relname,15)='bound_cosmetic_' or left(c.relname,14)='mining_roster_')),
      entitlement_tables as (select c.oid,c.relowner from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname in ('mining_claim_entitlement_headers','mining_claim_entitlement_leaves'))
      select current_user=session_user and not exists(select 1 from pg_roles r
        where pg_has_role(current_user,r.oid,'MEMBER') and (
          r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls
          or exists(select 1 from private_tables t where
            has_table_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            or has_any_column_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
          or exists(select 1 from entitlement_tables t where t.relowner=r.oid
            or has_table_privilege(r.oid,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            or has_any_column_privilege(r.oid,t.oid,'INSERT,UPDATE,REFERENCES')))) allowed`);
    if (!owner?.allowed || !request?.allowed) throw new Error('Phase E private source and request roles are not isolated');
    if (publicationRecoveryEnabled || publicationJobEnabled) {
      const admitted = await assertPhaseEKeepIdentity(connection.db, publication!.identity);
      const matches = (trust: MiningPublicationVerifierSources['trust']) => {
        try { return trust.expectedGenesisHash === admitted.genesisHash && trust.programId.toBase58() === admitted.economyProgram
          && trust.keepMint.toBase58() === admitted.keepMint && trust.reserveOwner.toBase58() === admitted.reserveOwner
          && trust.reviewedDeploymentSlot === admitted.economyDeployment.reviewedDeploymentSlot
          && trust.reviewedProgramDataSha256 === admitted.economyDeployment.reviewedProgramDataSha256; }
        catch { return false; }
      };
      if ((publicationRecoveryEnabled && !matches(publication!.verifierSources!.trust))
          || (publicationJobEnabled && (!matches(publication!.job!.reconcile.backing.trust)
            || !matches(publication!.job!.reconcile.settlement.trust)
            || (publication!.job!.sources.backing && !matches(publication!.job!.sources.backing.trust))))) {
        throw new Error('Mining publication identity differs from the admitted v4 binding');
      }
    }
    const identity = { finalizedDeedReader: ownership.finalizedDeedReader ?? null, deedCollection: ownership.deedCollection ?? null };
    const db = connection.db;
    // Restore canonical private ACLs through provisioning; never accept a new
    // source seal merely because these optional services were mounted.
    await db.execute(sql`select public.shardkeep_divine_trial_event_source(),public.shardkeep_divine_fragment_source()`);
    const divine = createDivineRuntime(db, { history: identity, term: seekerSources?.term ?? null,
      trial: divineQualification && config.DIVINE_TRIAL_SPONSOR_WALLET ? { ...identity,
        domain: { genesisHash: divineQualification.trust.expectedGenesisHash, economyProgram: divineQualification.trust.programId.toBase58() },
        sponsorWallet: config.DIVINE_TRIAL_SPONSOR_WALLET, qualificationSource: divineQualification } : null });
    const clanDivine = createDivineClanRuntime(db, { history: identity, term: seekerSources?.term ?? null,
      tournaments: { ...charterTournaments, recovery: charterRecovery ?? null },
      funding: charterRecovery && config.CHARTER_TOURNAMENT_SPONSOR_WALLET && config.CHARTER_TOURNAMENT_TREASURY ? {
        sponsorWallet: config.CHARTER_TOURNAMENT_SPONSOR_WALLET,
        domain: { genesisHash: charterRecovery.trust.expectedGenesisHash, economyProgram: charterRecovery.trust.economy.programId,
          craftProgram: charterRecovery.trust.craft.programId, treasury: config.CHARTER_TOURNAMENT_TREASURY } } : null });
    const vehicleWorkflow = { ...identity, ...vehicleSources?.workflow };
    const expeditionSources = { ...identity, ...seekerSources };
    // New material spending and equip-on require the actual renderer to admit
    // every exact current appearance binding. Original recovery stays independent.
    // C5 Wake consumer admission is not delivered: omit wakeApplicationReady.
    const boundCosmeticWorkshop = createBoundCosmeticWorkshop(db, { ...identity, awningApplicationReady: boundCosmeticAwningApplicationReady });
    const deps: ServiceDeps = Object.freeze({
      ...divine.deps,
      realmPassportProvider: createRealmPassportProvider(db, { ...(divineQualification ? { mining: {
        identity: { genesisHash: divineQualification.trust.expectedGenesisHash,
          programId: divineQualification.trust.programId.toBase58(),
          configAddress: miningConfigPda(divineQualification.trust.programId).toBase58() },
        assess: createMiningClaimReader(db, divineQualification).assess,
      } } : {}) }),
      keepEquipmentMarket: createKeepEquipmentMarketProvider(db, { ...identity, ...keepMarketSources }),
      miningContributionProvider: createMiningContributionProvider(db, { market: { finalizedDeedReader: identity.finalizedDeedReader, ...(identity.deedCollection ? { deedCollection: identity.deedCollection } : {}) } }),
      freeBasePurchaseProvider: createFreeBasePurchaseProvider(db),
      vehicleClientProvider: createVehicleClient(db, { ...identity, installation: vehicleWorkflow, service: vehicleWorkflow,
        expeditions: expeditionSources, ...vehicleSources ? { current: vehicleSources.current } : {} }),
      vehicleCraftClientProvider: createVehicleCraftClient(db, { ...identity, ...vehicleCraftRecovery }),
      vehicleWorkflowProvider: createVehicleWorkflow(db, vehicleWorkflow),
      vehicleServiceWorkflowProvider: createVehicleServiceWorkflow(db, vehicleWorkflow),
      advancedFleetViewProvider: createAdvancedFleetView(db, identity),
      advancedExpeditionWorkflowProvider: createAdvancedExpeditionWorkflow(db, expeditionSources),
      advancedExpeditionGameplay: createAdvancedExpeditionGameplay(db, identity),
      vehicleBerthOccupancyProvider: createVehicleBerthOccupancyProvider(db, identity),
      charterClientProvider: createClanCharterClient(db, { ...charterClient, creation: { ...charterClient?.creation, ...identity, recovery: charterRecovery ?? null }, sales: { ...charterClient?.sales, ...identity, recovery: charterRecovery ?? null } }),
      charterRetirementClientProvider: createClanCharterRetirementClient(db, { ...charterRetirement, ...identity, recovery: charterRecovery ?? null }),
      charterMigrationClientProvider: createClanCharterMigrationClient(db, { ...charterMigration, recovery: charterRecovery ?? null }),
      ...clanDivine.deps,
      seekerResourceClaimProvider: createSeekerResourceClaimProvider(db, identity),
      boundCosmeticWakeViews: createBoundCosmeticWakeViews(db, identity),
      boundCosmeticWorkshop,
      ordinaryEquipment: createOrdinaryEquipmentProvider(db, { ...identity, cosmeticCollection: boundCosmeticWorkshop }),
      starterExpeditionWorkflow: createStarterExpeditionWorkflow(db, { market: { finalizedDeedReader: identity.finalizedDeedReader, ...(identity.deedCollection ? { deedCollection: identity.deedCollection } : {}) },
        provider: seekerSources?.term ?? null, accessProvider: seekerSources?.access ?? null }),
      miningRosterEnrollmentProvider: createMiningRosterEnrollmentProvider(db),
      ...seekerSources ? {
        starterExpeditionProvider: seekerSources.term,
        starterExpeditionAccessProvider: seekerSources.access,
        harvesterProvider: seekerSources.term,
        physicalMineSourceProvider: seekerSources.term,
        // Registered/already-proven histories remain usable. The current deed
        // reader is deliberately not represented as continuous historical custody.
        physicalMineRecoveryProvider: createPhysicalMineRecoveryProvider(db, { historicalTerm: seekerSources.term }),
      } : {},
    });
    if (claimReceipts) verifier = await createMiningClaimVerifierRuntime(serviceUrl.toString(), claimReceipts);
    if (realmSaleReceipts) realmSaleVerifier = await createRealmSaleVerifierRuntime(serviceUrl.toString(), realmSaleReceipts);
    if (taxReceipts) taxVerifier = await createMiningTaxVerifierRuntime(serviceUrl.toString(), taxReceipts);
    if (publicationRecoveryEnabled) publicationVerifier = await createMiningPublicationVerifierRuntime(serviceUrl.toString(), publication!.verifierSources,
      { enabled: true, cluster: config.SOLANA_CLUSTER });
    if (publicationJobEnabled) publicationJob = createMiningPublicationJob(db, { ...publication!.job!,
      enabled: true, testerStack: true, cluster: config.SOLANA_CLUSTER,
      operator: new PublicKey(config.MINING_PUBLICATION_OPERATOR_PUBKEY!), hotWallet: new PublicKey(config.HOT_WALLET_PUBKEY!) });
    const publicationOperator = publicationJob ? createMiningPublicationOperator(db, {
      enabled: typeof publication?.authorizeAbort === 'function', testerStack: true, cluster: config.SOLANA_CLUSTER,
      operator: new PublicKey(config.MINING_PUBLICATION_OPERATOR_PUBKEY!), job: publicationJob,
      ...(publication?.authorizeAbort ? { authorizeAbort: publication.authorizeAbort } : {}),
    }) : null;
    // Explicit private operator capability; normal API startup never initializes
    // a sale epoch and the wallet-scoped AppDeps never receive this command.
    const saleDomain = charterClient?.sales?.newSaleDomain ? structuredClone(charterClient.sales.newSaleDomain) : null;
    const charterOperator = saleDomain ? Object.freeze({ initializeSaleEpoch: () => createClanCharterSalesStore(db).initializeEpoch(saleDomain) }) : null;
    let started = false, closing: Promise<void> | undefined;
    return Object.freeze({ deps, divineOperator: divine.operator, clanOperator: clanDivine.operator, charterOperator, publicationOperator, start: () => {
      if (started || closing) return; started = true;
      verifier?.start(); realmSaleVerifier?.start(); taxVerifier?.start(); publicationVerifier?.start(); publicationJob?.start();
    }, close: () => closing ??= (async () => {
      const results = await Promise.allSettled([verifier?.close(), realmSaleVerifier?.close(), taxVerifier?.close(), publicationVerifier?.close(), publicationJob?.close()]);
      await connection.sql.end();
      if (results.some(result => result.status === 'rejected')) throw new Error('Phase E private runtime shutdown failed');
    })() });
  } catch (error) {
    await Promise.allSettled([verifier?.close(), realmSaleVerifier?.close(), taxVerifier?.close(), publicationVerifier?.close(), publicationJob?.close()]);
    await connection.sql.end();
    throw error;
  }
}
