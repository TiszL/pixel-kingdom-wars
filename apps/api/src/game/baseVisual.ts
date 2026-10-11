/** Visual context is resolved from the same persisted address used by the
 * globe and metadata. It is never inferred from attacker identity or fed into
 * deterministic combat. Unplotted and legacy bases retain Crownlands. */
import { campaignBaseVisualForAct, currentBaseVisualForRealm, isRealmId,
  type BaseVisualContext, type RealmId } from '@shardkeep/shared/baseVisual';
import { devLoginRealm } from '../config';
import type { DbOrTx } from '../db/client';
import { isDevFixtureFantasyClaim, resolveFantasyLocation } from './fantasyLocationRead';

/** Realms this host previews at groundRevision 5 (REALM_KIT_PREVIEW_REALMS, see
 * config.ts). Read per call like multiBaseEnabled so tests can toggle it; an
 * unknown id throws here as well as at boot — a preview list must never half-apply. */
export function realmKitPreviewRealms(env: NodeJS.ProcessEnv = process.env): ReadonlySet<RealmId> {
  const raw = env['REALM_KIT_PREVIEW_REALMS']?.trim();
  if (!raw) return new Set();
  const realms = new Set<RealmId>();
  for (const id of raw.split(',').map((value) => value.trim()).filter(Boolean)) {
    if (!isRealmId(id)) throw new Error(`REALM_KIT_PREVIEW_REALMS names an unknown realm: ${id}`);
    realms.add(id);
  }
  return realms;
}

/** This host's current scenery for a realm: the shared activation table
 * (CURRENT_LAYERED_REVISION_BY_REALM), lifted to revision 5 only where this host
 * previews the realm kit (docs/REALM-KIT-PLAN.md §6 step 3). Production keeps the
 * shared answer — revision 4 — until the owner approves the pilot and the table
 * itself moves. Nothing here touches a context already frozen on a raid. */
export function currentBaseVisualHere(realmId: RealmId = 'crownlands'): BaseVisualContext {
  const current = currentBaseVisualForRealm(realmId);
  if (current.groundRevision === 5 || !realmKitPreviewRealms().has(realmId)) return current;
  return { ...current, artVersion: 2, groundRevision: 5 };
}

/** Campaign acts follow the same host rule as every other current context. */
export function campaignBaseVisualHere(act: number): BaseVisualContext {
  return currentBaseVisualHere(campaignBaseVisualForAct(act).realmId);
}

/** The persisted address decides — except, on a dev host, for the dev-login base under
 * DEV_LOGIN_REALM (config.ts; docs/REALM-THEMES-PLAN.md §3 P0 "Dev realm switch"). An
 * assigned fantasy claim can never be rebound, released or deleted (drizzle/0118
 * fantasy_claim_identity_guard), so the switch does not move the claim: it makes a
 * base whose claim rests on the dev-fixture receipt PRESENT the configured realm, and a
 * base with no fantasy address at all (a legacy dev base, or any base on a host that
 * runs without the fantasy world — the local review host does) presents it too. Every
 * presentation reader comes through here (GET /base, kit obstacles, the deed render,
 * native content, the context a new raid freezes), so all of them agree; the globe and
 * deed metadata keep reporting the persisted tile. A paid or migrated fantasy base
 * presents its own address even on a dev host. */
export async function resolveBaseVisual(db: DbOrTx, baseId?: string | null): Promise<BaseVisualContext> {
  const location = baseId ? await resolveFantasyLocation(db, baseId) : null;
  const presented = devLoginRealm();
  if (presented) {
    // No base id (a legacy single-base host reads by wallet) or no fantasy address: present.
    if (!baseId || !location) return currentBaseVisualHere(presented);
    if (presented !== location.realmId && await isDevFixtureFantasyClaim(db, baseId)) return currentBaseVisualHere(presented);
  }
  return currentBaseVisualHere(location?.realmId ?? 'crownlands');
}
