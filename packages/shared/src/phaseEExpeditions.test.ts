import { describe, expect, it } from 'vitest';
import { REALM_IDS } from './baseVisual';
import { PHASE_E_POLICY as P, PHASE_E_STARTER_ROUTES as C } from './constants';
import { PHASE_E_RAW_RESOURCES } from './phaseEResources';
import { StarterHomeRouteIdSchema, StarterCommonRouteIdSchema, StarterRouteIdSchema, StarterRoutePreviewSchema, starterRoutePreview } from './phaseEExpeditions';

describe('dark starter home-route previews', () => {
  it.each(REALM_IDS)('uses only %s home resource and conserves the complete taxed output', realm => {
    for (const route of StarterHomeRouteIdSchema.options) {
      const preview = starterRoutePreview(realm, route);
      expect(StarterRoutePreviewSchema.parse(preview)).toEqual(preview);
      expect(PHASE_E_RAW_RESOURCES[preview.resourceId].realmId).toBe(realm);
      const gross = BigInt(preview.grossQuantity), tax = BigInt(preview.islandPoolQuantity);
      expect(gross).toBe(tax + BigInt(preview.netQuantity));
      expect(tax * BigInt(P.basisPoints)).toBe(gross * BigInt(P.taxes.resources.islandPoolBps));
      expect(preview.vehicleFamily).toBe('starter');
    }
  });

  it('does not waive or duplicate inherited fractional tax carry for exact-yield trips', () => {
    // For any prior legal carry, an exact-tax yield leaves that carry unchanged.
    const basisPoints = BigInt(P.basisPoints), taxBps = BigInt(P.taxes.resources.islandPoolBps);
    for (const route of StarterRouteIdSchema.options) {
      const preview = starterRoutePreview('crownlands', route);
      const grossTaxNumerator = BigInt(preview.grossQuantity) * taxBps, expectedTax = BigInt(preview.islandPoolQuantity);
      let firstMismatch: { carry: bigint; quotient: bigint; remainder: bigint; expectedTax: bigint } | null = null;
      for (let carry = 0n; carry < basisPoints; carry++) {
        const numerator = carry + grossTaxNumerator;
        const quotient = numerator / basisPoints, remainder = numerator % basisPoints;
        const taxMatches = quotient === expectedTax, carryMatches = remainder === carry;
        // Evaluate both invariants for every carry, retaining a useful failure
        // without paying matcher construction cost inside the exhaustive loop.
        if ((!taxMatches || !carryMatches) && firstMismatch === null) {
          firstMismatch = { carry, quotient, remainder, expectedTax };
        }
      }
      expect(firstMismatch, `route ${route}`).toBeNull();
    }
  });

  it('rejects altered output, resource, timer, version and injected authority fields', () => {
    const preview = starterRoutePreview('crownlands', 'introduction');
    const tampered = [
      { ...preview, grossQuantity: '6' }, { ...preview, islandPoolQuantity: '0' },
      { ...preview, netQuantity: '5' }, { ...preview, resourceId: 'frost_quartz' },
      { ...preview, durationSec: preview.durationSec - 1 },
      { ...preview, rewardTableVersion: C.rewardTableVersion + 1 },
      { ...preview, routeCatalogueVersion: C.routeCatalogueVersion + 1 },
      { ...preview, vehicleFamily: 'cargo_cutter' }, { ...preview, termId: 'invented' },
      { ...preview, grossQuantity: 5 }, { ...preview, netQuantity: '04' },
    ];
    for (const value of tampered) expect(StarterRoutePreviewSchema.safeParse(value).success).toBe(false);
  });

  it('has no unknown realm/route fallback and returns independent preview values', () => {
    expect(() => starterRoutePreview('unknown' as never, 'introduction')).toThrow();
    expect(() => starterRoutePreview('crownlands', 'unknown' as never)).toThrow();
    const first = starterRoutePreview('crownlands', 'introduction');
    first.netQuantity = '999';
    expect(starterRoutePreview('crownlands', 'introduction').netQuantity).toBe('4');
    expect(StarterHomeRouteIdSchema.options).toEqual(Object.keys(C.routes));
    expect(StarterCommonRouteIdSchema.options).toEqual(Object.keys(C.commonV1.routes));
  });

  it('provides mixed lengths with explicit prompt-redispatch upper bounds, not offline compounding', () => {
    const hourly = StarterHomeRouteIdSchema.options.map(route => {
      const preview = starterRoutePreview('crownlands', route);
      return Number(preview.netQuantity) * 3600 / preview.durationSec;
    });
    expect(hourly).toEqual([48, 40, 32]);
    // A completed trip remains one receipt regardless of how late it is observed.
    expect(starterRoutePreview('crownlands', 'long_survey').netQuantity).toBe('64');
  });
});


describe('D153.26 explicit common starter catalogue', () => {
  it('covers every native raw family from any home without changing HOME output', () => {
    for (const home of REALM_IDS) {
      const routes = StarterCommonRouteIdSchema.options.map(id => starterRoutePreview(home, id));
      expect(new Set(routes.map(r => r.resourceId))).toEqual(new Set(Object.keys(PHASE_E_RAW_RESOURCES)));
      for (const r of routes) {
        expect(StarterRoutePreviewSchema.parse(r)).toEqual(r);
        expect(r.realmId).toBe(PHASE_E_RAW_RESOURCES[r.resourceId].realmId);
        expect(r.routeId).toBe(`common_${r.realmId.replaceAll('-', '_')}`);
        expect(r.access).toEqual({ kind: 'starter_common', policyVersion: C.commonV1.accessPolicyVersion });
        const native = starterRoutePreview(r.realmId, 'coastal_survey');
        expect(r.durationSec).toBe(native.durationSec);
        expect(BigInt(r.grossQuantity) * 5n).toBe(BigInt(native.grossQuantity));
        expect(BigInt(r.netQuantity) + BigInt(r.islandPoolQuantity)).toBe(BigInt(r.grossQuantity));
      }
    }
  });

  it('never turns route selection into arbitrary destination, policy or permit authority', () => {
    const p = starterRoutePreview('crownlands', 'common_frostveil');
    const { access: _, ...stripped } = p;
    for (const bad of [stripped, { ...p, realmId: 'elderwood' }, { ...p, resourceId: 'heartwood_logs' },
      { ...p, access: { ...p.access, policyVersion: 2 } }, { ...p, access: { ...p.access, permit: true } },
      { ...p, access: { kind: 'paid_permit', policyVersion: 1 } }, { ...p, rewardTableVersion: 1 },
      { ...starterRoutePreview('crownlands', 'introduction'), access: p.access }]) {
      expect(StarterRoutePreviewSchema.safeParse(bad).success).toBe(false);
    }
  });
});
