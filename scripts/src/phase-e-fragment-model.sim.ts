/** Run: pnpm --filter @shardkeep/scripts exec tsx src/phase-e-fragment-model.sim.ts */
import { PHASE_E_FRAGMENT_MODEL as P, PHASE_E_POLICY as LOCKED } from '../../packages/shared/src/constants';
import { recipeExpectation, type Rational } from './phase-e-fragment-model';

const fraction = (r: Rational): string => `${r.n}/${r.d}`;
console.log(`D153.187 PROPOSED fragment model v${P.version}; synthetic logical inputs, no issuance.`);
console.log('Allocation shares are individual/clan/salvage. Vacancies and unfunded awards stay unissued.');
console.log('All-failure winning salvage below is a ceiling stress, not a forecast. Each modeled attempt has preexisting quoted fragment inputs and an earned opportunity. No price/demand/revenue assumptions.');
const rows: Record<string, string>[] = [];
for (const ceiling of P.weeklyCeilings) for (const allocation of P.allocations) for (const population of P.populationScenarios) {
  // Closed-form cohort ledger avoids quadratic copies at the high-population
  // bound. Everyone has one personal day opportunity; every supplied loss wins.
  const bps = BigInt(LOCKED.basisPoints);
  const individual = ceiling * allocation[0] / bps / BigInt(P.individualSites);
  const clan = ceiling * allocation[1] / bps / BigInt(P.clanSites);
  const salvageSlots = ceiling * allocation[2] / bps / P.salvageMax;
  let gross = 0n; let tax = 0n;
  for (let wallet = 0n; wallet < population; wallet++) {
    const earned = (wallet < BigInt(P.individualSites) ? individual : 0n)
      + (wallet < BigInt(P.clanSites) ? clan : 0n)
      + (wallet < salvageSlots ? P.salvageMax : 0n);
    gross += earned; tax += earned * BigInt(LOCKED.taxes.resources.islandPoolBps) / bps;
  }
  if (gross > ceiling) throw new Error('scenario budget exceeded');
  const crafts = population < salvageSlots ? population : salvageSlots;
  const inputStock = crafts * P.recipeInputs[0];
  const taxed = { issued: gross, reserved: 0n, unissued: ceiling - gross, player: gross - tax, tax };
  const exempt = { player: gross };
  rows.push({ ceiling: String(ceiling), sharesBps: allocation.join('/'), wallets: String(population),
    initialCraftStock: String(inputStock), burnedByCrafts: String(inputStock), gross: String(taxed.issued), reserved: String(taxed.reserved), unissued: String(taxed.unissued),
    playerTaxable: String(taxed.player), taxHeldZeroWinners: String(taxed.tax), playerExempt: String(exempt.player) });
}
console.table(rows);
console.table(P.recipeInputs.map((input, tier) => {
  const r = recipeExpectation(tier);
  return { tier: String(tier + 1), fragmentInput: String(input), successBps: String(P.recipeSuccessBps[tier]),
    expectedAttempts: fraction(r.attempts), expectedGrossConsumed: fraction(r.grossFragments),
    expectedNetConsumedWithMaxEligibleSalvage: fraction(r.netFragments), applicationLamportsPerSuccess: fraction(r.fee),
    minimumSinkEvenEveryAttemptSalvages: String(input - P.salvageMax) };
}));
console.log(`Known application fee per attempt: ${LOCKED.craft.applicationFeeLamports} lamports. Network/provider/mint costs omitted.`);
console.log('Taxable fresh-production and wholly exempt-source cases are sensitivity endpoints; no owner tax classification is inferred.');
console.log('Proven zero winners hold deducted tax permanently for the original term; unavailable authority blocks earning. King spots have no multiplier.');
console.log('One personal finalized Renown increment/day opportunity is synthetic free eligibility: no deed/vehicle/extra-attempt purchase, not zero onboarding/network SOL.');
console.log('Seven-day canonical budget periods and admission; unresolved attempts retain quoted fragments and original issuance reservations. Ordinary results burn quoted fragments once. No timeout refund or provider terminal proof.');
console.log('Recipes contain fragment sensitivity only. Actual free fragment delivery, complete materials, authenticated VRF, K140, source classification, and E-D03/E-D06 acceptance remain open.');
