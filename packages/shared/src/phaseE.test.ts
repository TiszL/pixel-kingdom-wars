import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REALM_IDS } from './baseVisual';
import { GEMS, PHASE_E_POLICY as P } from './constants';
import { buildPhaseECatalogue, PhaseECatalogueResponseSchema } from './phaseE';

describe('Phase E locked future-policy catalogue', () => {
  it('cannot advertise gameplay activation or an unrecognized policy version', () => {
    const catalogue = buildPhaseECatalogue();
    expect(catalogue.status).toBe('specified');
    expect(catalogue.gameplayEnabled).toBe(false);
    expect(PhaseECatalogueResponseSchema.safeParse({ ...catalogue, gameplayEnabled: true }).success).toBe(false);
    expect(PhaseECatalogueResponseSchema.safeParse({ ...catalogue, version: catalogue.version + 1 }).success).toBe(false);
  });

  it('reserves the full gross budget between disjoint pools without a wallet payout cap', () => {
    const { mining, basisPoints } = buildPhaseECatalogue();
    expect(mining.freePoolBps + mining.deedPoolBps).toBe(basisPoints);
    expect(mining.freePoolBps).toBeLessThan(mining.deedPoolBps);
    expect(mining.grossDailyCeilingKeep).toBeGreaterThan(0);
    expect(mining.budgetBasis).toBe('gross');
    expect(mining.fixedWalletPayoutCapKeep).toBeNull();
    // A capacity limit is wallet-wide, while zero activity/contribution earns nothing.
    expect(mining.freeCapacityUnitsPerWalletDay).toBeGreaterThan(0);
    expect(mining.currentActivityRequired && mining.dailyContributionRequired
      && mining.progressionQualificationRequired).toBe(true);
    expect(mining.bonusScope).toBe('additive-per-base');
    expect(mining.crossBaseBonusStacking).toBe(false);
    expect(basisPoints + mining.seekerBonusBps + mining.genesisBaseBonusBps)
      .toBeLessThan((basisPoints + mining.seekerBonusBps) * (basisPoints + mining.genesisBaseBonusBps) / basisPoints);
  });

  it('preserves every gross tax unit and routes no earnings tax to developers', () => {
    const { taxes, basisPoints } = buildPhaseECatalogue();
    expect(Object.values(taxes.resources).reduce<number>((sum, leg) => sum + leg, 0)).toBe(basisPoints);
    expect(Object.values(taxes.minedKeep).reduce<number>((sum, leg) => sum + leg, 0)).toBe(basisPoints);
    expect(taxes.resources.devBps).toBe(0);
    expect(taxes.minedKeep.devBps).toBe(0);
    expect(taxes.resources.islandPoolBps).toBe(taxes.minedKeep.islandPoolBps + taxes.minedKeep.recycleBps);
    expect(taxes.minedKeep.islandPoolBps).toBe(taxes.minedKeep.recycleBps);
    expect(taxes.keepMarket.sellerBps + taxes.keepMarket.burnBps).toBe(basisPoints);
    expect(taxes.keepMarket.burnKind).toBe('spl-burn');
    expect(taxes.assessment).toBe('new-earnings-once');
    expect(taxes.resourceScope).toBe('resources-and-shards');
    expect(taxes.recycleTiming).toBe('future-funded-epoch');
    expect(taxes.taxClaimsAgain || taxes.taxExistingBalances).toBe(false);
  });

  it('separates paid roster replacement from free navigation and progression gates', () => {
    const { bases, forge } = buildPhaseECatalogue();
    expect(bases.replacementFeeLamports).toBeGreaterThan(0);
    expect(bases.navigationFeeLamports).toBe(0);
    expect(bases.freePerWalletMax).toBeLessThan(bases.activePerWalletMax);
    expect(bases.secondFreeBaseProgressionRequired).toBe(true);
    expect(bases.secondFreeBaseCostShards).toBeGreaterThan(forge.shardsPerIngot);
    expect(forge.workshopRequired && forge.refiningCapped && forge.storageCapped).toBe(true);
  });

  it('gives kings broader contract access but equal pooled-tax shares', () => {
    const { seekerIsland: island, realms } = buildPhaseECatalogue();
    expect(island.kingSpots + island.regularSpots).toBe(island.totalSpots);
    expect(island.regularRealmCountMin).toBeGreaterThan(0);
    expect(island.regularRealmCountMin).toBeLessThanOrEqual(island.regularRealmCountMax);
    expect(island.regularRealmCountMax).toBeLessThan(island.realmCount);
    expect(realms.map(realm => realm.id)).toEqual(REALM_IDS);
    expect(new Set(realms.map(realm => realm.id)).size).toBe(island.realmCount);
    expect(island.kingContracts).toBe('all-realms');
    expect(island.jurisdiction).toBe('all-realms');
    expect(island.taxSharing).toBe('equal-winning-spots');
    expect(island.unsoldSpots).toBe('blocked-until-next-term');
    expect(island.contractSalesScope).toBe('spot-across-all-realms');
  });

  it('keeps contract SOL with the seller and team instead of the global tax pool', () => {
    const { seekerIsland: island, basisPoints } = buildPhaseECatalogue();
    expect(island.contractSellerBps + island.contractDevBps).toBe(basisPoints);
    expect(island.contractSellerBps).toBe(island.contractDevBps);
    expect(island.contractSolPooled).toBe(false);
    expect(island.permitPriceLamports * island.contractSellerBps % basisPoints).toBe(0);
    expect(island.permitScope).toBe('one-additional-realm');
    expect(island.vehicleRequired && island.permitSurvivesOwnerChange).toBe(true);
  });

  it('overlaps auctions with full operating terms instead of shortening ownership', () => {
    const { seekerIsland: island } = buildPhaseECatalogue();
    expect(island.overlappingAuctionSec).toBeGreaterThan(0);
    expect(island.overlappingAuctionSec).toBeLessThan(island.operatingTermSec);
    expect(island.auctionPlacement).toBe('final-day-overlap');
    expect(island.permitDurationSec).toBe(island.operatingTermSec);
  });

  it('does not silently sponsor claim or replacement chain costs', () => {
    const { claims, craft } = buildPhaseECatalogue();
    expect(claims.applicationFeeLamports).toBe(0);
    expect(claims.networkFeePayer).toBe('claimant');
    expect(claims.accountRentPayer).toBe('claimant');
    // D152 removed the genesis program; custody becomes Gems without a claim.
    expect(claims.genesis).toBe('none');
    expect(craft.applicationFeeLamports).toBeGreaterThan(0);
    expect(craft.chainAndOracleCostPayer).toBe('player');
    expect(craft.technicalReplacement).toBe('app-fee-waived-once-after-terminal-proof');
  });

  it('describes the canonical crafting application-fee split without changing its obligation', () => {
    const { craft, basisPoints } = buildPhaseECatalogue();
    expect(craft.applicationFeeLamports).toBe(P.craft.applicationFeeLamports);
    expect(craft.operatorBps).toBe(P.craft.operatorBps);
    expect(craft.projectBps).toBe(P.craft.projectBps);
    expect(craft.operatorBps + craft.projectBps).toBe(basisPoints);
  });

  it('rejects missing, retuned or unknown crafting split fields', () => {
    const catalogue = buildPhaseECatalogue();
    const { operatorBps, ...withoutOperator } = catalogue.craft;
    const { projectBps, ...withoutProject } = catalogue.craft;
    for (const craft of [
      withoutOperator,
      withoutProject,
      { ...catalogue.craft, operatorBps: operatorBps + 1 },
      { ...catalogue.craft, projectBps: projectBps + 1 },
      // Conserving the total does not authorize a different allocation.
      { ...catalogue.craft, operatorBps: operatorBps + 1, projectBps: projectBps - 1 },
      { ...catalogue.craft, unknownCraftFee: true },
    ]) expect(PhaseECatalogueResponseSchema.safeParse({ ...catalogue, craft }).success).toBe(false);
  });

  it('describes the locked Solana workshop licence supply from the policy catalogue', () => {
    const catalogue = buildPhaseECatalogue();
    expect(catalogue.solanaIsland).toEqual(P.solanaIsland);
    expect(catalogue.solanaIsland.workshopLicences).toBe(P.solanaIsland.workshopLicences);
  });

  it('requires the canonical Solana licence field and rejects retuning or extra island fields', () => {
    const catalogue = buildPhaseECatalogue();
    const { solanaIsland, ...withoutSolanaIsland } = catalogue;
    expect(PhaseECatalogueResponseSchema.safeParse(withoutSolanaIsland).success).toBe(false);
    for (const invalid of [
      {},
      { ...solanaIsland, workshopLicences: solanaIsland.workshopLicences + 1 },
      { ...solanaIsland, unknownLicenceSupply: true },
    ]) expect(PhaseECatalogueResponseSchema.safeParse({ ...catalogue, solanaIsland: invalid }).success).toBe(false);
  });

  it('advertises Gems as a closed, one-way in-game currency that mirrors the GEMS locks (D-152)', () => {
    const { currencies, seekerIsland, decisions } = buildPhaseECatalogue();
    expect(decisions).toContain('D-152');
    expect(currencies.spendable).toEqual(['SOL', 'SKR', 'KEEP', 'GEMS']);
    // Resources are not currencies: SHARDS, the eight realm resources, Crystal Fragments.
    expect(currencies.resources.realmResourceCount).toBe(seekerIsland.realmCount);
    expect(currencies.resources.shards && currencies.resources.crystalFragments).toBe(true);
    // 1:1 both ways, never back to KEEP, never withdrawable or listable, no burn leg.
    expect(currencies.gems.gemsPerKeep).toBe(GEMS.gemsPerKeep);
    expect(currencies.gems.shardsPerGem).toBe(GEMS.shardsPerGem);
    expect(currencies.gems.gemsPerKeep * currencies.gems.shardsPerGem).toBe(1);
    expect(currencies.gems.purchaseBurnBps).toBe(0);
    expect(currencies.gems.withdrawable || currencies.gems.listable || currencies.gems.reversible).toBe(false);
    expect(currencies.gems.source).toBe('keep-conversion-only');
    expect(currencies.gems.recycleDestination).toBe('emission-reserve');
    expect(currencies.gems.onChainCreditForPurchasedGems).toBe(false);
    // Markets never price in Gems; the legacy custodial balance has no genesis claim.
    expect(Object.values(currencies.markets)).not.toContain('GEMS');
    expect(currencies.markets).toEqual({ resources: 'KEEP', items: 'KEEP', nft: 'SOL', auctions: 'SKR' });
    expect(currencies.legacyCustodialKeep).toBe('converts-to-gems-at-cutover');
    expect(GEMS.minConvertKeep).toBeGreaterThan(0);
    expect(GEMS.maxConvertKeepPerTx).toBeGreaterThan(GEMS.minConvertKeep);
  });

  it('rejects silent tuning proposals, changed payouts and invalid realm catalogues', () => {
    const catalogue = buildPhaseECatalogue();
    for (const invalid of [
      { ...catalogue, unknownFeature: true },
      { ...catalogue, claims: { ...catalogue.claims, genesis: 'dedicated-g2' } },
      { ...catalogue, mining: { ...catalogue.mining, decayEndSec: P.mining.scoreGraceSec } },
      { ...catalogue, mining: { ...catalogue.mining, fixedWalletPayoutCapKeep: P.mining.grossDailyCeilingKeep } },
      { ...catalogue, taxes: { ...catalogue.taxes, resources: { ...catalogue.taxes.resources, devBps: P.taxes.resources.islandPoolBps } } },
      { ...catalogue, currencies: { ...catalogue.currencies, gems: { ...catalogue.currencies.gems, withdrawable: true } } },
      { ...catalogue, currencies: { ...catalogue.currencies, gems: { ...catalogue.currencies.gems, shardsPerGem: 2 } } },
      { ...catalogue, currencies: { ...catalogue.currencies, markets: { ...catalogue.currencies.markets, items: 'GEMS' } } },
      { ...catalogue, currencies: { ...catalogue.currencies, legacyCustodialKeep: 'genesis-claim' } },
      { ...catalogue, seekerIsland: { ...catalogue.seekerIsland, salesDayBoundary: 'UTC' } },
      { ...catalogue, realms: catalogue.realms.map(() => catalogue.realms[0]) },
      { ...catalogue, realms: catalogue.realms.map(realm => ({ ...realm, yield: P.forge.shardsPerIngot })) },
    ]) expect(PhaseECatalogueResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('returns deterministic, detached JSON-safe values without bigint or lossy amounts', () => {
    const catalogue = buildPhaseECatalogue();
    const original = JSON.stringify(catalogue);
    expect(JSON.stringify(buildPhaseECatalogue())).toBe(original);
    expect(PhaseECatalogueResponseSchema.parse(JSON.parse(original))).toEqual(catalogue);
    const check = (value: unknown): void => {
      if (typeof value === 'number') expect(Number.isSafeInteger(value)).toBe(true);
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(check);
      else expect(['string', 'boolean', 'object']).toContain(typeof value);
    };
    check(catalogue);
    catalogue.realms[0]!.name = 'mutated consumer copy';
    Object.assign(catalogue.mining, { fixedWalletPayoutCapKeep: P.mining.grossDailyCeilingKeep });
    expect(JSON.stringify(buildPhaseECatalogue())).toBe(original);
    expect(P.mining.fixedWalletPayoutCapKeep).toBeNull();
  });

  it('requires an explicit subpath import instead of expanding the shared barrel', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.exports['./phaseE']).toBe('./src/phaseE.ts');
    expect(readFileSync(new URL('./index.ts', import.meta.url), 'utf8')).not.toMatch(/from ['"]\.\/phaseE['"]/);
  });
});
