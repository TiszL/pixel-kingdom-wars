/**
 * SIM_VERSION — the REPLAY PROTOCOL version.
 *
 * Resolved raids persist their authoritative result and event log; replay clients
 * play that stored log rather than re-running old snapshot/orders/seed inputs.
 * SIM_VERSION still fences the LIVE create/resolve protocol: a pending raid is
 * pinned to the simulator version under which it was created, and clients must
 * understand the event protocol the server will produce when orders resolve.
 * Change the sim — retune a troop, fix pathing, or add a replay event — and that
 * compatibility boundary must move deliberately.
 *
 * This matters when a paid raid spans a rollout: resolving old pending orders
 * under an unaudited simulator could change its outcome or produce events the
 * creating client cannot render. The API therefore fails closed before simulation
 * or economy mutation, except for explicitly audited outcome-neutral transitions.
 *
 * So: bump this whenever `simulateRaid` can produce different output for the same
 * input, including render-only event-log changes. The server stamps the active raid
 * protocol at create/resolve time and negotiates it with current clients.
 *
 * You do not have to remember to bump it. `tests/sim-version.test.ts` fingerprints
 * every golden fixture and fails if behaviour moved without this number moving —
 * see that file for how to satisfy it.
 *
 * History
 *   1 — D4a/D4b: heroes, hero skills, keg refactor. Everything up to 2026-07-28.
 *   2 — 2026-07-29: stun honoured on both sides; blocked units commit to their
 *       detour; giant reworked from wall-opener to defence-seeking tank; hero dps
 *       corrected from 10x (dps*10 into a per-TICK field) to its published value.
 *   3 — 2026-08-08 (rework v2): giant hp 700→1600, gains siegeThrow — boulders
 *       at defense targets within 2.5 tiles (over walls, no-LoS convention),
 *       cadenced troopFire proj:'boulder'; a wall blocking his path is melee'd
 *       at dps×buildingDamageMult (was 1× last-resort only). Gap-preference
 *       pathing unchanged; heroes isolated via behaviorOf as before.
 *   4 — 2026-08-10 (troop rework v3): Keg Runner approach movement now emits
 *       the same cadenced `pos` render keyframes as every other moving troop.
 *       Combat outcomes are unchanged; replay event logs now place its run and
 *       authored detonation at the wall instead of the deployment point.
 *   5 — 2026-08-10 (troop rework v3): burrow movement emits cadenced `pos`
 *       keyframes plus an exact terminal point before emerge; Troll damage emits
 *       cadenced `troopAttack` cues for defender troops, walls and buildings.
 *       Both are render-only; combat outcomes are unchanged.
 *   6 — 2026-08-11: favorite-target selection now falls back through reachable
 *       structures and walls instead of stalling on an unreachable favorite;
 *       Gloamfang, Direwyvern, Hexbarrow and spawn-only Barrowlings add authored
 *       deterministic abilities plus troopSpawn/troopAbility/burnfield events.
 *       This is outcome-changing; pending v5 raids are intentionally incompatible.
 *   7 — 2026-08-11: non-hero melee cues are self-describing and include
 *       Gloamfang's real rend cadence; blocked armies elect one deterministic
 *       wall breach; Direwyvern firestorm carries its visual structure identity.
 *   8 — 2026-08-12: defender Wyrmling damage emits its existing cadenced breath
 *       render cue. Combat outcomes are unchanged; replay event logs now show
 *       the spawned defender's actual attack instead of an unexplained hit.
 *   9 — 2026-08-12: full authored troop cycles own contact/projectile damage,
 *       compact attackRun records replace synthetic visual ticks, Mage is
 *       single-target, and accepted effects drain after the 90-second horn.
 *  10 — 2026-08-15 (M22): Air Defence, four tiered spent/repairable trap
 *       families, distance-selected L15/L17 Keep batteries and Clan Hall enter
 *       authoritative combat; every trap remains outside destruction scoring.
 *  11 — 2026-08-16 (D-060, K-030): anti-air reach is measured to the defense's
 *       footprint edge (the flyer's own anchor), so equal-range towers actually
 *       fire on the dragon dismantling them; Cannon range 3→6 ("increase cannon
 *       range 2 times for attack"), Archer Tower 4→7 ("increase archer range
 *       too"), Air Defence dps 45→110 (the dedicated counter must counter);
 *       the L17 Keep low battery keeps its own pinned 3-tile reach instead of
 *       inheriting the cannon doubling. Outcome-changing everywhere towers
 *       fight; pending v10 raids are intentionally incompatible.
 *  12 — 2026-09-02 (D-099, decisive walls): goal tiles exclude walls; blocked
 *       units decide breach-vs-detour once and commit; nearest breach
 *       election; defence-seekers breach to their defence; WALL_COST moves
 *       to SIM_PATHING.wallCost. Outcome-changing wherever masonry stands
 *       between a grounded unit and its target; pending v11 raids are
 *       intentionally incompatible (the deploy drains live raids first).
 *  13 — 2026-09-03: a hero committed to breaching a blocking wall emits the
 *       same render-only `heroAttack` recovery cue as its ordinary building
 *       swing. Damage, cadence, targeting and outcomes are unchanged.
 *  14 — 2026-09-04: a hero's basic swing on a building (ordinary target and
 *       committed wall breach) publishes its applied damage as an ordinary
 *       `hit`, like every troop impact, skill and splash path already did.
 *       `heroAttack` carries no amount, so the client's building HP mirror
 *       never moved for hero-only damage (tester: "building HP bar does not
 *       visibly decrease … eventually gets destroyed"). Render-only: damage,
 *       cadence, targeting and outcomes are byte-identical.
 *  15 — 2026-09-15: version-2 snapshots allow empty claim interiors and the
 *       full 98×98 battlefield. Missing/version-1 deployment and movement remain
 *       unchanged. Independent plotVersion 2 supports the signed 50×50 building
 *       frame, including walls, routes and defender guards; missing/1 keeps the
 *       legacy frame. Both additions belong to this unreleased candidate.
 *       Archived events and golden fixtures are never rewritten.
 *  16 — 2026-09-17 (owner relaying players: giants "going to another place
 *       when a target is nearby"): (a) a siegeThrow unit whose held target is
 *       out of reach switches to the nearest defence inside its throw reach
 *       instead of walking past it — no oscillation, since neither he nor the
 *       building moves while he throws; (b) a defence-seeker's pick prices a
 *       sealed defence as distance + SIM_TARGETING.sealedDefenceAllowanceTiles
 *       against the nearest open defence, so a gun four tiles away behind a
 *       wall beats one thirteen tiles away in the open. (a) is gated on the
 *       siegeThrow role (the giant alone); (b) prices every grounded
 *       defence-seeker's pick (giant, Theodor) and is inert for fliers, for
 *       whom everything is reachable. Every other unit is byte-identical and
 *       the golden corpus is unchanged (no fixture holds a defence-seeker
 *       near a second defence). Pending v15 raids are intentionally
 *       incompatible.
 *  17 — 2026-09-19 (D-146): new battlefield-v3 snapshots admit a troop or hero
 *       only when its selected tile belongs to a fully empty 2×2 square. V1/V2
 *       deployment and every historical golden remain unchanged. Pending v16
 *       unstarted, unarmed raids use existing mismatch cancellation/refunds.
 *       Started/armed v16 raids require their pinned worker and the deploy drain;
 *       accepted orders are never silently reinterpreted.
 *  18 — 2026-09-22 (Phase E): Workshop, Lodge, Market, Harvester and the single
 *       Berth type enter the placement contract as passive 2×2 destructibles.
 *       Their existing HP/footprint cases now have an all-five golden; no attack,
 *       resource-target privilege or historical combat algorithm changes.
 *       All earlier golden bytes and deployment versions remain unchanged.
 *       Pending v17 raids keep the exact-version refusal/refund/drain policy;
 *       archived outcomes/events are never re-simulated. Placement remains dark
 *       pending coordinated content/native compatibility and release gates.
 */
export const SIM_VERSION = 18;

/** The dormant geometry-v2 decoder does not bump SIM_VERSION: no production
 * snapshot creator stamps v2 yet, and missing/v1 snapshots are byte-for-byte and
 * outcome-identical. The rollout that first creates v2 snapshots must bump the
 * replay protocol and migrate/validate live layouts deliberately. */
