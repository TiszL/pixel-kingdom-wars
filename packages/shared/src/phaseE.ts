/** Read-only future-policy contract. This subpath is deliberately absent from
 * the shared barrel: no client or simulation opts into Phase E by importing it.
 * The catalogue exposes owner locks, not economic readiness or live actions. */
import { z } from 'zod';
import { PHASE_E_POLICY as P, PHASE_E_MINING_CLAIM_FORMAT as CLAIM_FORMAT } from './constants';
import { REALM_IDS, REALM_NAMES } from './baseVisual';

export const PhaseECatalogueResponseSchema = z.object({
  version: z.literal(1),
  status: z.literal('specified'),
  gameplayEnabled: z.literal(false),
  decisions: z.tuple([z.literal('D-149'), z.literal('D-150'), z.literal('D-152')]),
  basisPoints: z.literal(P.basisPoints),
  solanaIsland: z.object({
    workshopLicences: z.literal(P.solanaIsland.workshopLicences),
  }).strict(),
  realms: z.array(z.object({ id: z.enum(REALM_IDS), name: z.string() }).strict())
    .length(P.seekerIsland.realmCount)
    .refine(realms => realms.every((realm, i) => realm.id === REALM_IDS[i]
      && realm.name === REALM_NAMES[realm.id]), 'canonical realm catalogue required'),
  mining: z.object({
    claimFormat: z.object({version: z.literal(CLAIM_FORMAT.version), computeUnitLimit: z.literal(CLAIM_FORMAT.computeUnitLimit)}).strict(),
    grossDailyCeilingKeep: z.literal(P.mining.grossDailyCeilingKeep),
    freePoolBps: z.literal(P.mining.freePoolBps), deedPoolBps: z.literal(P.mining.deedPoolBps),
    freeCapacityUnitsPerWalletDay: z.literal(P.mining.freeCapacityUnitsPerWalletDay),
    fixedWalletPayoutCapKeep: z.null(),
    scoreGraceSec: z.literal(P.mining.scoreGraceSec),
    seekerBonusBps: z.literal(P.mining.seekerBonusBps),
    genesisBaseBonusBps: z.literal(P.mining.genesisBaseBonusBps),
    budgetBasis: z.literal('gross'),
    bonusScope: z.literal('additive-per-base'), crossBaseBonusStacking: z.literal(false),
    currentActivityRequired: z.literal(true), dailyContributionRequired: z.literal(true),
    progressionQualificationRequired: z.literal(true),
  }).strict(),
  bases: z.object({
    activePerWalletMax: z.literal(P.bases.activePerWalletMax),
    freePerWalletMax: z.literal(P.bases.freePerWalletMax),
    replacementFeeLamports: z.literal(P.bases.replacementFeeLamports),
    navigationFeeLamports: z.literal(P.bases.navigationFeeLamports),
    secondFreeBaseCostShards: z.literal(P.bases.secondFreeBaseCostShards),
    secondFreeBaseProgressionRequired: z.literal(true),
  }).strict(),
  forge: z.object({
    shardsPerIngot: z.literal(P.forge.shardsPerIngot), workshopRequired: z.literal(true),
    refiningCapped: z.literal(true), storageCapped: z.literal(true),
  }).strict(),
  taxes: z.object({
    assessment: z.literal('new-earnings-once'),
    resourceScope: z.literal('resources-and-shards'),
    resources: z.object({
      playerBps: z.literal(P.taxes.resources.playerBps),
      islandPoolBps: z.literal(P.taxes.resources.islandPoolBps),
      devBps: z.literal(P.taxes.resources.devBps),
    }).strict(),
    minedKeep: z.object({
      playerBps: z.literal(P.taxes.minedKeep.playerBps),
      islandPoolBps: z.literal(P.taxes.minedKeep.islandPoolBps),
      recycleBps: z.literal(P.taxes.minedKeep.recycleBps),
      devBps: z.literal(P.taxes.minedKeep.devBps),
    }).strict(),
    keepMarket: z.object({
      sellerBps: z.literal(P.taxes.keepMarket.sellerBps),
      burnBps: z.literal(P.taxes.keepMarket.burnBps), burnKind: z.literal('spl-burn'),
    }).strict(),
    recycleTiming: z.literal('future-funded-epoch'),
    taxClaimsAgain: z.literal(false), taxExistingBalances: z.literal(false),
  }).strict(),
  seekerIsland: z.object({
    totalSpots: z.literal(P.seekerIsland.totalSpots),
    kingSpots: z.literal(P.seekerIsland.kingSpots),
    regularSpots: z.literal(P.seekerIsland.regularSpots),
    realmCount: z.literal(P.seekerIsland.realmCount),
    regularRealmCountMin: z.literal(P.seekerIsland.regularRealmCountMin),
    regularRealmCountMax: z.literal(P.seekerIsland.regularRealmCountMax),
    paidContractsPerSpotDayMax: z.literal(P.seekerIsland.paidContractsPerSpotDayMax),
    operatingTermSec: z.literal(P.seekerIsland.operatingTermSec),
    overlappingAuctionSec: z.literal(P.seekerIsland.overlappingAuctionSec),
    permitDurationSec: z.literal(P.seekerIsland.permitDurationSec),
    permitPriceLamports: z.literal(P.seekerIsland.permitPriceLamports),
    contractSellerBps: z.literal(P.seekerIsland.contractSellerBps),
    contractDevBps: z.literal(P.seekerIsland.contractDevBps),
    jurisdiction: z.literal('all-realms'), taxSharing: z.literal('equal-winning-spots'),
    kingContracts: z.literal('all-realms'), contractSalesScope: z.literal('spot-across-all-realms'),
    auctionPlacement: z.literal('final-day-overlap'),
    unsoldSpots: z.literal('blocked-until-next-term'), contractSolPooled: z.literal(false),
    permitScope: z.literal('one-additional-realm'), vehicleRequired: z.literal(true),
    permitSurvivesOwnerChange: z.literal(true),
    realmRarityAndProductionDiffer: z.literal(true),
  }).strict(),
  currencies: z.object({
    spendable: z.tuple([z.literal('SOL'), z.literal('SKR'), z.literal('KEEP'), z.literal('GEMS')]),
    resources: z.object({
      shards: z.literal(true), realmResourceCount: z.literal(P.currencies.resources.realmResourceCount),
      crystalFragments: z.literal(true),
    }).strict(),
    gems: z.object({
      gemsPerKeep: z.literal(P.currencies.gems.gemsPerKeep), shardsPerGem: z.literal(P.currencies.gems.shardsPerGem),
      purchaseBurnBps: z.literal(P.currencies.gems.purchaseBurnBps),
      withdrawable: z.literal(false), listable: z.literal(false), reversible: z.literal(false),
      source: z.literal('keep-conversion-only'), recycleDestination: z.literal('emission-reserve'),
      onChainCreditForPurchasedGems: z.literal(false),
    }).strict(),
    markets: z.object({
      resources: z.literal('KEEP'), items: z.literal('KEEP'), nft: z.literal('SOL'), auctions: z.literal('SKR'),
    }).strict(),
    legacyCustodialKeep: z.literal('converts-to-gems-at-cutover'),
  }).strict(),
  craft: z.object({
    applicationFeeLamports: z.literal(P.craft.applicationFeeLamports),
    operatorBps: z.literal(P.craft.operatorBps),
    projectBps: z.literal(P.craft.projectBps),
    chainAndOracleCostPayer: z.literal('player'),
    technicalReplacement: z.literal('app-fee-waived-once-after-terminal-proof'),
  }).strict(),
  claims: z.object({
    applicationFeeLamports: z.literal(P.claims.applicationFeeLamports),
    networkFeePayer: z.literal('claimant'), accountRentPayer: z.literal('claimant'),
    genesis: z.literal('none'),
  }).strict(),
}).strict();
export type PhaseECatalogueResponse = z.infer<typeof PhaseECatalogueResponseSchema>;

/** Parsing supplies a fresh deep copy and verifies every advertised lock. No
 * wall clock, DB, client input, flag activation or gameplay side effect. */
export function buildPhaseECatalogue(): PhaseECatalogueResponse {
  return PhaseECatalogueResponseSchema.parse({
    version: 1, status: 'specified', gameplayEnabled: false, decisions: ['D-149', 'D-150', 'D-152'],
    ...P,
    realms: REALM_IDS.map(id => ({ id, name: REALM_NAMES[id] })),
    mining: {
      claimFormat: {...CLAIM_FORMAT},
      ...P.mining, budgetBasis: 'gross', bonusScope: 'additive-per-base', crossBaseBonusStacking: false,
      currentActivityRequired: true, dailyContributionRequired: true, progressionQualificationRequired: true,
    },
    bases: { ...P.bases, secondFreeBaseProgressionRequired: true },
    forge: { ...P.forge, workshopRequired: true, refiningCapped: true, storageCapped: true },
    taxes: {
      ...P.taxes, assessment: 'new-earnings-once', resourceScope: 'resources-and-shards',
      keepMarket: { ...P.taxes.keepMarket, burnKind: 'spl-burn' },
      recycleTiming: 'future-funded-epoch', taxClaimsAgain: false, taxExistingBalances: false,
    },
    seekerIsland: {
      ...P.seekerIsland, jurisdiction: 'all-realms', taxSharing: 'equal-winning-spots',
      kingContracts: 'all-realms', contractSalesScope: 'spot-across-all-realms',
      auctionPlacement: 'final-day-overlap', unsoldSpots: 'blocked-until-next-term', contractSolPooled: false,
      permitScope: 'one-additional-realm', vehicleRequired: true, permitSurvivesOwnerChange: true,
      realmRarityAndProductionDiffer: true,
    },
    currencies: {
      ...P.currencies,
      gems: {
        ...P.currencies.gems, reversible: false, source: 'keep-conversion-only',
        recycleDestination: 'emission-reserve', onChainCreditForPurchasedGems: false,
      },
    },
    craft: { ...P.craft, chainAndOracleCostPayer: 'player', technicalReplacement: 'app-fee-waived-once-after-terminal-proof' },
    claims: { ...P.claims, networkFeePayer: 'claimant', accountRentPayer: 'claimant', genesis: 'none' },
  });
}
