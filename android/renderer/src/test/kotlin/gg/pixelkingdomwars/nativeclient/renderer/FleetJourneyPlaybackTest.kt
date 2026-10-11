package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Test
import kotlin.test.*

/** N-C5 renderer consumer against a SYNTHETIC admitted-art fixture. The active pack carries no
 *  journey art, so these cases prove the consumer's contract (starter selection on the starter facts and
 *  advanced selection ONLY on exact typed current family/tier facts, admitted-art validation and freezing, authored offsets AND opacity, Wake on the
 *  craft contact, gate effect seat, reduced motion, admission-bound start/draw and revocation), not
 *  that any installed pack can draw a journey. The fixture's numbers are the web sidecar's authored
 *  starter track and starter craft geometry, copied as data. */
class FleetJourneyPlaybackTest {
    private val berth = RenderBuilding("berth-1", "service:berth:1", 10f, 8f, 2f, 2f, type = "berth", level = 1, service = RenderServiceIdentity("berth", null))
    private val facts = RenderServiceFacts(true, berths = listOf(RenderBerthPresentation(berth.id, RenderStarterInstallation("starter", RenderStarterPresence.OCCUPIED))))
    private val aurora = RenderJourneyWake.Available("aurora_wake", "b".repeat(64), "m".repeat(64), "i".repeat(64))
    private fun journey(kind: RenderJourneyKind = RenderJourneyKind.DEPARTURE, family: String = "starter", tier: Int? = null,
        wake: RenderJourneyWake = RenderJourneyWake.Legacy, berthId: String = berth.id, baseId: String = "base-1") =
        RenderFleetJourney("$kind:$family:e1", kind, baseId, berthId, "inst-1", RenderJourneyVehicle(family, tier), wake)
    private fun scene(baseId: String? = "base-1", building: RenderBuilding = berth) =
        BaseScene(listOf(building), columns = 12, rows = 12, tilePixels = 32f, baseId = baseId, services = facts)
    /** GL-side install as the renderer does it: the art is whatever Main last set; the lifetime is observed first. */
    private fun installed(playback: FleetJourneyPlayback, scene: BaseScene = scene(), generation: Long = 1L, art: FleetJourneyArt? = this.art): JourneyAdmission {
        playback.replaceArt(art); assertTrue(playback.install(scene, generation, null, playback.lifetime())); return assertNotNull(playback.admission())
    }

    // Authored starter track (apps/web sidecar peTracks): eight steps at 8 fps, tidal gate at [56,28].
    private val offsets = listOf(0f, -4f, -10f, -16f, -22f, -28f, -34f, -40f)
    private val opacities = listOf(1f, 1f, 1f, 1f, .85f, .5f, .15f, 0f)
    private val departure = offsets.indices.map { JourneyStep(it, ServicePoint(0f, offsets[it]), opacities[it]) }
    private val back = departure.asReversed().mapIndexed { index, step -> step.copy(frame = index) }
    private val starterTrack = JourneyTrack(8f, departure, back, ServicePoint(56f, 28f), "departure")
    private val craft = JourneyVehicleArt("atlas/pe_fleet_starter@1x.json", (1..4).map { "pe_veh_starter_docked_f$it" }, 8f, ServicePoint(112f, 112f), ServicePoint(56f, 105f), ServicePoint(0f, -27f))
    private val gate = JourneyEffectArt("atlas/pe_fleet_starter@1x.json", (1..8).map { "pe_fx_departure_f$it" }, 8f, ServicePoint(64f, 64f), "pe_fx_departure_still_f1")
    private val wakeArt = JourneyEffectArt("atlas/pe_cosmetics@1x.json", (1..8).map { "pe_cos_wake_f$it" }, 8f, ServicePoint(64f, 64f), "pe_cos_wake_f1")
    private class Fixture(val tracks: Map<String, JourneyTrack>, val craft: JourneyVehicleArt?, val gate: JourneyEffectArt?, val wake: JourneyEffectArt?,
        val binding: RenderJourneyWake.Available) : FleetJourneyArt {
        override fun track(family: String) = tracks[family]
        override fun vehicle(family: String, tier: Int?) = craft?.takeIf { family in tracks && (family == "starter") == (tier == null) }
        override fun gateEffect(kind: RenderJourneyKind) = gate
        override fun wake(wake: RenderJourneyWake.Available) = this.wake?.takeIf { wake == binding }
    }
    private val art = Fixture(mapOf("starter" to starterTrack), craft, gate, wakeArt, aurora)
    /** Records which art key the consumer asks for; crafts are keyed `<dash-family>:<tier>` (the starter: `starter`). The same
     *  craft object answers every key so the plan stays resident; the KEY is what these cases prove. */
    private class KeyedFixture(val tracks: Map<String, JourneyTrack>, val crafts: Map<String, JourneyVehicleArt>, val gate: JourneyEffectArt?, val wake: JourneyEffectArt?,
        val binding: RenderJourneyWake.Available) : FleetJourneyArt {
        val requested = mutableListOf<Pair<String, Int?>>()
        override fun track(family: String) = tracks[family]
        override fun vehicle(family: String, tier: Int?): JourneyVehicleArt? { requested += family to tier; return crafts[if (tier == null) family else "$family:$tier"] }
        override fun gateEffect(kind: RenderJourneyKind) = gate
        override fun wake(wake: RenderJourneyWake.Available) = this.wake?.takeIf { wake == binding }
    }
    private val wireFamilies = listOf("survey_balloon", "cargo_cutter", "courier_airship", "expedition_barge")
    private val nautical = setOf("cargo_cutter", "expedition_barge") // tidal-gate families carry the shared gate effect
    private val liftoff = starterTrack.copy(sharedFxRef = null, effectAttachmentPx = ServicePoint(56f, 40f))
    private fun advancedArt() = KeyedFixture(mapOf("starter" to starterTrack) + wireFamilies.associate { journeyFamilyKey(it) to (if (it in nautical) starterTrack else liftoff) },
        mapOf("starter" to craft) + wireFamilies.flatMap { f -> (1..4).map { t -> "${journeyFamilyKey(f)}:$t" to craft } } + ("zeppelin:1" to craft), gate, wakeArt, aurora)
    /** Typed CURRENT advanced facts for this berth (starter sibling explicitly null unless [starterInstalled]). */
    private fun advancedFacts(family: String = "survey_balloon", tier: Int = 1, presence: RenderAdvancedPresence = RenderAdvancedPresence.OCCUPIED,
        starterInstalled: Boolean = false, rows: List<RenderAdvancedBerth>? = listOf(RenderAdvancedBerth(berth.id, RenderAdvancedInstallation(family, tier, presence)))) =
        RenderServiceFacts(true, berths = listOf(RenderBerthPresentation(berth.id, if (starterInstalled) RenderStarterInstallation("starter", RenderStarterPresence.OCCUPIED) else null)),
            currentAdvancedBerths = rows)
    // The resident atlases exactly as an admission's asset set would hold them: every normal frame AND the
    // separately authored `*_still_f1` cell of the gate effect / Wake, each under its own exact atlas path.
    private fun cell(key: String, texture: String) = ServicePackedCell(texture, key.hashCode() and 0xfff, 64, 64, 64)
    private fun cells(texture: String, keys: Collection<String>) = keys.associateWith { cell(it, texture) }
    private val starterAtlas = JourneyResidentAtlas("atlas/pe_fleet_starter@1x.json", cells("fleet.png", craft.frames + gate.frames + listOfNotNull(gate.still)))
    private val cosmeticsAtlas = JourneyResidentAtlas("atlas/pe_cosmetics@1x.json", cells("cos.png", wakeArt.frames + listOfNotNull(wakeArt.still)))
    private val resident = listOf(starterAtlas, cosmeticsAtlas)
    /** Main-side start as the renderer does it: the plan's cells are verified against the resident atlases first. */
    private fun FleetJourneyPlayback.startResident(journey: RenderFleetJourney, plan: JourneyPlan, nowMs: Long, admission: JourneyAdmission) =
        start(journey, plan, nowMs, admission, assertNotNull(verifiedJourneyCells(plan, resident), "the fixture's plan is resident"))
    private fun plan(journey: RenderFleetJourney, art: FleetJourneyArt? = this.art, building: RenderBuilding = berth, facts: RenderServiceFacts = this.facts, reduced: Boolean = false) =
        selectJourneyPlan(art, building, facts, journey, reduced)

    @Test fun `selects the starter track for the exact completed berth and never invents art`() {
        val plan = assertNotNull(plan(journey(wake = aurora)))
        assertEquals(departure, plan.steps); assertEquals(1000f, plan.durationMs); assertEquals(ServicePoint(56f, 28f), plan.effectAttachmentPx)
        assertNotNull(plan.effect); assertNotNull(plan.wake); assertEquals(setOf(craft.atlasPath, wakeArt.atlasPath), plan.atlasPaths)
        assertEquals(back, assertNotNull(plan(journey(RenderJourneyKind.RETURN))).steps)
        // Legacy, Off and unavailable captures and a hash disagreement draw no Wake; the journey still plays.
        for (wake in listOf(RenderJourneyWake.Legacy, RenderJourneyWake.Off, RenderJourneyWake.Unavailable, aurora.copy(bindingSha256 = "f".repeat(64))))
            assertNull(assertNotNull(plan(journey(wake = wake))).wake)
        // No admitted art, a foreign berth, construction, a level-0 row, a plain building or a missing installation select nothing.
        assertNull(plan(journey(), art = null))
        assertNull(plan(journey(berthId = "berth-9")))
        assertNull(plan(journey(), building = berth.copy(underConstruction = true)))
        assertNull(plan(journey(), building = berth.copy(level = 0)))
        assertNull(plan(journey(), building = berth.copy(level = null)), "a null level is not a completed berth")
        assertNull(plan(journey(), building = berth.copy(type = "mine", service = null)))
        assertNull(plan(journey(), facts = RenderServiceFacts(true, berths = emptyList())))
        assertNull(plan(journey(), facts = RenderServiceFacts(true, berths = listOf(RenderBerthPresentation(berth.id, RenderStarterInstallation("survey-balloon", RenderStarterPresence.OCCUPIED))))))
        // A named gate effect that is not admitted refuses the whole journey.
        assertNull(plan(journey(), art = Fixture(mapOf("starter" to starterTrack), craft, null, wakeArt, aurora)))
    }

    @Test fun `typed current facts admit each advanced family and tier through its OWN art key - a starter with a tier still refuses`() {
        for (wire in wireFamilies) for (tier in 1..4) {
            val art = advancedArt()
            val plan = assertNotNull(plan(journey(family = wire, tier = tier), art = art, facts = advancedFacts(wire, tier)), "$wire t$tier")
            assertEquals(listOf<Pair<String, Int?>>(journeyFamilyKey(wire) to tier), art.requested, "the craft is looked up by the dash family key and the MAPPED tier")
            assertEquals(departure, plan.steps); assertEquals(craft.frames, plan.vehicle.frames)
            if (wire in nautical) { assertNotNull(plan.effect, "tidal-gate family carries the shared gate effect"); assertEquals(ServicePoint(56f, 28f), plan.effectAttachmentPx) }
            else { assertNull(plan.effect, "vertical lift-off has no gate effect"); assertEquals(ServicePoint(56f, 40f), plan.effectAttachmentPx) }
            assertEquals(back, assertNotNull(plan(journey(RenderJourneyKind.RETURN, family = wire, tier = tier), art = advancedArt(), facts = advancedFacts(wire, tier))).steps)
        }
        assertEquals("survey-balloon", journeyFamilyKey("survey_balloon"))
        assertNull(plan(journey(family = "starter", tier = 1), art = advancedArt()), "a starter with a tier is not the starter installation shape")
        assertNull(plan(journey(family = "starter", tier = 1), art = advancedArt(), facts = advancedFacts("survey_balloon", 1)), "a tiered starter never matches an advanced row either")
    }

    @Test fun `an event or offered art alone never supplies current advanced facts - every mismatch refuses before any art lookup`() {
        val cases: List<Pair<String, RenderServiceFacts>> = listOf(
            "starter-only facts (no advanced section)" to facts,
            "unknown advanced projection (null list, as a battle-mapped scene)" to advancedFacts(rows = null),
            "known empty advanced closure" to advancedFacts(rows = emptyList()),
            "null installation on this berth" to advancedFacts(rows = listOf(RenderAdvancedBerth(berth.id, null))),
            "the row of another berth" to advancedFacts(rows = listOf(RenderAdvancedBerth("berth-9", RenderAdvancedInstallation("survey_balloon", 1, RenderAdvancedPresence.OCCUPIED)))),
            "duplicate matching rows" to advancedFacts(rows = List(2) { RenderAdvancedBerth(berth.id, RenderAdvancedInstallation("survey_balloon", 1, RenderAdvancedPresence.OCCUPIED)) }),
            "another installed family" to advancedFacts("cargo_cutter", 1),
            "the same family at another tier" to advancedFacts("survey_balloon", 2),
            "contradictory installed siblings" to advancedFacts("survey_balloon", 1, starterInstalled = true),
        )
        for ((name, current) in cases) {
            val art = advancedArt()
            assertNull(plan(journey(family = "survey_balloon", tier = 1), art = art, facts = current), name)
            assertEquals(emptyList(), art.requested, "no art lookup before the facts match: $name")
        }
        // The event itself can never fill or widen the facts.
        val art = advancedArt()
        assertNull(plan(journey(family = "survey_balloon", tier = null), art = art, facts = advancedFacts("survey_balloon", 1)), "a missing event tier is never taken from the facts")
        assertNull(plan(journey(family = "survey_balloon", tier = 5), art = art, facts = advancedFacts("survey_balloon", 5)), "tier outside 1..4")
        assertNull(plan(journey(family = "zeppelin", tier = 1), art = art, facts = advancedFacts("zeppelin", 1)), "unsupported family even with art and a matching row")
        assertNull(plan(journey(family = "survey-balloon", tier = 1), art = art, facts = advancedFacts("survey_balloon", 1)), "the event speaks the underscore wire vocabulary only")
        assertEquals(emptyList(), art.requested)
        // Contradictory installed siblings refuse the STARTER event as well: no precedence is chosen.
        assertNull(plan(journey(), art = advancedArt(), facts = advancedFacts("survey_balloon", 1, starterInstalled = true)))
        assertNotNull(plan(journey(), art = advancedArt(), facts = advancedFacts(rows = listOf(RenderAdvancedBerth(berth.id, null)), starterInstalled = true)), "an explicit null advanced sibling leaves the starter installation valid")
        assertNotNull(plan(journey(), art = advancedArt(), facts = advancedFacts(rows = null, starterInstalled = true)), "an absent advanced sibling never erases the starter positive")
    }

    @Test fun `presence is carried as a fact and never gates - departures and returns select against OCCUPIED AWAY and EXHAUSTED alike - nothing is originated or corrected`() {
        for (presence in RenderAdvancedPresence.values()) {
            val current = advancedFacts("cargo_cutter", 3, presence); val before = current.copy()
            assertNotNull(plan(journey(family = "cargo_cutter", tier = 3), art = advancedArt(), facts = current), "departure against $presence (the pre-command scene may still say OCCUPIED)")
            assertNotNull(plan(journey(RenderJourneyKind.RETURN, family = "cargo_cutter", tier = 3), art = advancedArt(), facts = current), "return against $presence")
            assertEquals(before, current, "selection reads the facts and changes nothing; it originates no event and corrects no presence")
            assertEquals(presence, current.currentAdvancedBerths!!.single().installation!!.presence)
        }
    }

    @Test fun `an admitted advanced journey still cancels on EVERY scene submission - even the same base family and tier - and a battle-mapped scene admits none`() {
        val art = advancedArt(); val current = advancedFacts("expedition_barge", 2)
        val scene = BaseScene(listOf(berth), columns = 12, rows = 12, tilePixels = 32f, baseId = "base-1", services = current)
        val playback = FleetJourneyPlayback(); val admitted = installed(playback, scene, 1L, art)
        val plan = assertNotNull(plan(journey(family = "expedition_barge", tier = 2), art = art, facts = current))
        assertTrue(playback.startResident(journey(family = "expedition_barge", tier = 2), plan, 0L, admitted)); assertTrue(playback.isActive(berth.id))
        val out = mutableListOf<JourneySprite>(); assertTrue(playback.sprites(berth, 10L, 0f, 32f, out)); assertTrue(out.any { it.sprite.clip.key == "journey-craft" })
        // Same base, same family, same tier, same presence: the projection carries no installation identity, so the flight ends.
        val replacement = BaseScene(listOf(berth), columns = 12, rows = 12, tilePixels = 32f, baseId = "base-1", services = advancedFacts("expedition_barge", 2))
        assertTrue(playback.install(replacement, 2L, null, playback.lifetime()))
        assertFalse(playback.isActive(), "every scene submission cancels, same base/family/tier included"); assertFalse(playback.sprites(berth, 20L, 0f, 32f, mutableListOf()))
        // A battle-mapped scene leaves the current-only field null: nothing advanced selects against it.
        val battleMapped = RenderServiceFacts(null, berths = listOf(RenderBerthPresentation(berth.id, null)), currentAdvancedBerths = null)
        assertNull(plan(journey(family = "expedition_barge", tier = 2), art = art, facts = battleMapped))
    }

    @Test fun `R1 refuses malformed or mutable injected art before any flight and freezes admitted data`() {
        fun fixture(craft: JourneyVehicleArt? = this.craft, gate: JourneyEffectArt? = this.gate, wake: JourneyEffectArt? = wakeArt, track: JourneyTrack = starterTrack) =
            Fixture(mapOf("starter" to track), craft, gate, wake, aurora)
        assertNull(plan(journey(), art = fixture(craft = craft.copy(frames = emptyList()))), "empty craft frames")
        assertNull(plan(journey(), art = fixture(craft = craft.copy(fps = Float.NaN))), "NaN craft fps")
        assertNull(plan(journey(), art = fixture(craft = craft.copy(cell = ServicePoint(0f, 112f)))), "zero cell")
        assertNull(plan(journey(), art = fixture(craft = craft.copy(contactPx = ServicePoint(Float.POSITIVE_INFINITY, 105f)))), "infinite contact")
        assertNull(plan(journey(), art = fixture(craft = craft.copy(atlasPath = " "))), "blank atlas path")
        assertNull(plan(journey(), art = fixture(track = starterTrack.copy(fps = Float.NaN))), "NaN track fps")
        assertNull(plan(journey(), art = fixture(track = starterTrack.copy(departure = departure.map { it.copy(opacity = 1.5f) }))), "opacity above one")
        assertNull(plan(journey(), art = fixture(track = starterTrack.copy(departure = departure.map { it.copy(frame = 0) }))), "track ordinal not frame == index")
        assertNull(plan(journey(), art = fixture(track = starterTrack.copy(back = emptyList()))), "empty return steps")
        assertNull(plan(journey(), art = fixture(track = starterTrack.copy(effectAttachmentPx = ServicePoint(Float.NaN, 28f)))), "NaN effect seat")
        assertNull(plan(journey(), art = fixture(gate = gate.copy(frames = emptyList()))), "empty effect frames")
        assertNull(plan(journey(), art = fixture(gate = gate.copy(still = " "))), "a declared still must name a cell")
        // The authored still is its OWN packed cell (no normal frame shares its RGBA digest): membership in the normal sequence is not required.
        assertEquals("pe_fx_departure_still_f1", assertNotNull(plan(journey())).effect?.still)
        assertEquals((1..8).map { "pe_fx_departure_f$it" }, assertNotNull(plan(journey())).effect?.frames, "the eight normal frames stay unchanged")
        assertNull(plan(journey(wake = aurora), art = fixture(wake = wakeArt.copy(fps = 0f))), "present but malformed Wake art refuses the flight")
        // Admitted lists are copied: mutating the provider's lists afterwards changes nothing and cannot reach GL.
        val mutableFrames = (1..4).map { "pe_veh_starter_docked_f$it" }.toMutableList()
        val mutableSteps = departure.toMutableList()
        val live = fixture(craft = craft.copy(frames = mutableFrames), track = starterTrack.copy(departure = mutableSteps))
        val plan = assertNotNull(plan(journey(), art = live))
        mutableFrames.clear(); mutableSteps.clear()
        assertEquals(4, plan.vehicle.frames.size); assertEquals(8, plan.steps.size)
        assertFailsWith<UnsupportedOperationException> { (plan.steps as MutableList<JourneyStep>).clear() }
        assertFailsWith<UnsupportedOperationException> { (plan.vehicle.frames as MutableList<String>).clear() }
    }

    @Test fun `plays the authored departure once against its admission - craft offsets AND opacity, Wake on the contact, gate effect at the tidal gate - then ends`() {
        val playback = FleetJourneyPlayback(); val tile = 32f
        val admitted = installed(playback)
        val plan = assertNotNull(plan(journey(wake = aurora)))
        assertTrue(playback.startResident(journey(wake = aurora), plan, 1_000L, admitted))
        val seatX = (10f + 1f) * tile; val seatY = (8f + 2f) * tile
        for ((index, step) in departure.withIndex()) {
            val out = mutableListOf<JourneySprite>()
            assertTrue(playback.sprites(berth, 1_000L + index * 125L, 100f, tile, out))
            val craftSprite = out.single { it.sprite.clip.key == "journey-craft" }
            // Contact = seat + dock [0,−27] + contact [56,105] − pivot [56,112] = seat + [0,−34], plus the authored offset.
            assertEquals(seatX, craftSprite.sprite.x); assertEquals(seatY - 34f + step.offsetPx.y, craftSprite.sprite.y)
            assertEquals(step.opacity, craftSprite.alpha); assertEquals(100f + FleetJourneyPlayback.CRAFT_DEPTH, craftSprite.sprite.depth)
            assertEquals(56f / 112f, craftSprite.sprite.anchorX); assertEquals(105f / 112f, craftSprite.sprite.anchorY)
            val wake = out.single { it.sprite.clip.key == "journey-wake" }
            assertEquals(craftSprite.sprite.x, wake.sprite.x); assertEquals(craftSprite.sprite.y, wake.sprite.y)
            assertEquals(step.opacity, wake.alpha); assertEquals(.5f, wake.sprite.anchorX); assertEquals(100f + FleetJourneyPlayback.WAKE_DEPTH, wake.sprite.depth)
            assertEquals("pe_cos_wake_f${index + 1}", wake.sprite.frameKey)
            val fx = out.single { it.sprite.clip.key == "journey-effect" }
            assertEquals(seatX, fx.sprite.x); assertEquals(seatY - 84f, fx.sprite.y); assertEquals(1f, fx.alpha); assertEquals(100f + FleetJourneyPlayback.EFFECT_DEPTH, fx.sprite.depth)
            assertEquals("pe_fx_departure_f${index + 1}", fx.sprite.frameKey)
        }
        // The track is one second long: at 1000 ms the journey has ended and nothing more is drawn.
        assertFalse(playback.sprites(berth, 2_000L, 100f, tile, mutableListOf()))
        assertFalse(playback.isActive())
    }

    @Test fun `returns enter from the far step and rest at the dock`() {
        val playback = FleetJourneyPlayback(); val tile = 32f; val admitted = installed(playback)
        assertTrue(playback.startResident(journey(RenderJourneyKind.RETURN), assertNotNull(plan(journey(RenderJourneyKind.RETURN))), 0L, admitted))
        val first = mutableListOf<JourneySprite>(); assertTrue(playback.sprites(berth, 0L, 0f, tile, first))
        assertEquals((8f + 2f) * tile - 34f - 40f, first.single { it.sprite.clip.key == "journey-craft" }.sprite.y); assertEquals(0f, first.single { it.sprite.clip.key == "journey-craft" }.alpha)
        assertTrue(first.none { it.sprite.clip.key == "journey-wake" }, "a legacy capture draws no Wake")
        val last = mutableListOf<JourneySprite>(); assertTrue(playback.sprites(berth, 999L, 0f, tile, last))
        assertEquals((8f + 2f) * tile - 34f, last.single { it.sprite.clip.key == "journey-craft" }.sprite.y); assertEquals(1f, last.single { it.sprite.clip.key == "journey-craft" }.alpha)
    }

    @Test fun `R1 admission interleaving - stale START and stale INSTALL are both refused after a newer install, a revoke or an art replacement`() {
        val playback = FleetJourneyPlayback(); val tile = 32f
        val plan = assertNotNull(plan(journey()))
        assertNull(playback.admission()); assertEquals(0L, playback.lifetime())
        // Nothing installed: a stale JourneyAdmission object cannot start anything.
        playback.replaceArt(art)
        assertFalse(playback.startResident(journey(), plan, 0L, JourneyAdmission(scene(), 9L, null, art, playback.lifetime())))
        val a = installed(playback, generation = 1L); assertSame(a, playback.admission()); assertSame(art, a.art)
        // Main captured A; GL installs the replacement B (same base, newer generation) before Main inserts: the old insert is refused.
        val b = installed(playback, generation = 2L)
        assertFalse(playback.startResident(journey(), plan, 0L, a)); assertFalse(playback.isActive())
        assertTrue(playback.startResident(journey(), plan, 0L, b)); assertTrue(playback.sprites(berth, 10L, 0f, tile, mutableListOf()))
        // A flight started under B is dropped as soon as GL installs C (same base), before any other change.
        val c = installed(playback, generation = 3L); assertFalse(playback.isActive())
        assertTrue(playback.startResident(journey(), plan, 0L, c)); assertTrue(playback.sprites(berth, 10L, 0f, tile, mutableListOf()), "a flight under the installed admission draws")
        // Stale INSTALL after an art replacement: GL observed the lifetime, Main replaced the art (even non-null → non-null)
        // before GL installed — the stale install is refused without erasing Main's newer admission or restoring stale art.
        val observed = playback.lifetime()
        val otherArt = Fixture(mapOf("starter" to starterTrack), craft, gate, wakeArt, aurora)
        playback.replaceArt(otherArt); assertFalse(playback.isActive())
        val reissued = assertNotNull(playback.admission()); assertNotSame(c, reissued); assertSame(otherArt, reissued.art); assertSame(c.scene, reissued.scene)
        assertFalse(playback.startResident(journey(), plan, 0L, c), "the pre-replacement admission is stale")
        assertFalse(playback.install(scene(), 4L, null, observed), "an install decided before the replacement is stale")
        assertSame(reissued, playback.admission(), "stale work cannot erase the newer art admission"); assertFalse(playback.isActive(), "the art replacement still revoked the original")
        // The art the next install carries is the one Main set, captured under the monitor, never a GL-side copy.
        assertTrue(playback.install(scene(), 5L, null, playback.lifetime())); assertSame(otherArt, assertNotNull(playback.admission()).art)
        // Stale INSTALL after a revoke (pause/dispose/permission/source/battle): refused; a fresh install works again.
        val d = assertNotNull(playback.admission()); assertTrue(playback.startResident(journey(), plan, 0L, d))
        val beforeRevoke = playback.lifetime(); playback.revoke()
        assertFalse(playback.isActive()); assertNull(playback.admission()); assertFalse(playback.startResident(journey(), plan, 0L, d))
        assertFalse(playback.install(scene(), 6L, null, beforeRevoke)); assertNull(playback.admission())
        val e = installed(playback, generation = 7L, art = otherArt); assertSame(otherArt, e.art)
        // An admission for another base never admits this journey at draw even if inserted.
        val foreign = installed(playback, scene = scene(baseId = "base-2"), generation = 8L)
        assertTrue(playback.startResident(journey(), plan, 0L, foreign))
        assertFalse(playback.sprites(berth, 10L, 0f, tile, mutableListOf()), "journey base differs from the admitted scene"); assertFalse(playback.isActive())
    }

    @Test fun `residency - every normal key AND the separate still resolve in the ONE resident atlas at the exact path, else the journey drops`() {
        val plan = assertNotNull(plan(journey(wake = aurora)))
        val ok = assertNotNull(verifiedJourneyCells(plan, resident))
        assertEquals(craft.frames.toSet(), ok.vehicle.keys); assertEquals((gate.frames + "pe_fx_departure_still_f1").toSet(), assertNotNull(ok.effect).keys)
        assertEquals((wakeArt.frames + "pe_cos_wake_f1").toSet(), assertNotNull(ok.wake).keys)
        assertSame(starterAtlas.cells.getValue("pe_fx_departure_still_f1"), ok.effect!!.getValue("pe_fx_departure_still_f1"))
        assertFailsWith<UnsupportedOperationException> { (ok.vehicle as MutableMap<String, ServicePackedCell>).clear() }
        // The separate still is missing from the resident atlas: drop (never substitute a normal frame).
        val noStill = JourneyResidentAtlas(starterAtlas.path, starterAtlas.cells - "pe_fx_departure_still_f1")
        assertNull(verifiedJourneyCells(plan, listOf(noStill, cosmeticsAtlas)))
        // A normal frame missing: drop. A Wake frame missing: drop (the Wake was admitted, so it must be resident).
        assertNull(verifiedJourneyCells(plan, listOf(JourneyResidentAtlas(starterAtlas.path, starterAtlas.cells - "pe_fx_departure_f5"), cosmeticsAtlas)))
        assertNull(verifiedJourneyCells(plan, listOf(starterAtlas, JourneyResidentAtlas(cosmeticsAtlas.path, cosmeticsAtlas.cells - "pe_cos_wake_f3"))))
        // No atlas at the exact path, or an ambiguous pair at that path: drop — a colliding key elsewhere is never consulted.
        val elsewhere = JourneyResidentAtlas("atlas/other@1x.json", starterAtlas.cells)
        assertNull(verifiedJourneyCells(plan, listOf(elsewhere, cosmeticsAtlas)))
        assertNull(verifiedJourneyCells(plan, listOf(starterAtlas, starterAtlas.copy(cells = cells("fleet2.png", starterAtlas.cells.keys)), cosmeticsAtlas)))
        // Without a Wake the cosmetics atlas is not needed; a blank-still-free plan with no effect needs only the craft.
        assertNotNull(verifiedJourneyCells(assertNotNull(plan(journey())), listOf(starterAtlas)))
        // Reduced motion with a residency that lacks the still (hand-built) never starts.
        val playback = FleetJourneyPlayback(); val admitted = installed(playback)
        val reduced = assertNotNull(plan(journey(), reduced = true))
        assertFalse(playback.start(journey(), reduced, 0L, admitted, JourneyResidency(ok.vehicle, ok.effect!! - "pe_fx_departure_still_f1", null)))
        assertTrue(playback.start(journey(), reduced, 0L, admitted, assertNotNull(verifiedJourneyCells(reduced, resident))))
        // Every emitted normal-motion sprite carries the cell verified for ITS key.
        val motion = FleetJourneyPlayback(); val a = installed(motion); val out = mutableListOf<JourneySprite>()
        assertTrue(motion.startResident(journey(wake = aurora), plan, 0L, a)); assertTrue(motion.sprites(berth, 250L, 0f, 32f, out))
        out.forEach { sprite -> val atlas = if (sprite.sprite.clip.key == "journey-wake") cosmeticsAtlas else starterAtlas
            assertEquals(atlas.cells.getValue(sprite.sprite.frameKey), sprite.cell, sprite.sprite.frameKey) }
    }

    @Test fun `reduced motion is the authored immediate transition - no craft movement, no Wake, the gate effect still for the track duration`() {
        val playback = FleetJourneyPlayback(); val tile = 32f; val admitted = installed(playback)
        val plan = assertNotNull(plan(journey(wake = aurora), reduced = true))
        assertTrue(plan.reducedMotion); assertTrue(playback.startResident(journey(wake = aurora), plan, 0L, admitted))
        val out = mutableListOf<JourneySprite>(); assertTrue(playback.sprites(berth, 500L, 0f, tile, out))
        assertEquals(listOf("journey-effect-still"), out.map { it.sprite.clip.key }); assertEquals("pe_fx_departure_still_f1", out.single().sprite.frameKey)
        assertEquals(starterAtlas.cells.getValue("pe_fx_departure_still_f1"), out.single().cell, "the still draws its own verified resident cell")
        assertFalse(playback.sprites(berth, 1_000L, 0f, tile, mutableListOf()))
        // No gate still to hold (a track without a shared effect): under reduced motion nothing starts.
        val noEffect = Fixture(mapOf("starter" to starterTrack.copy(sharedFxRef = null)), craft, null, wakeArt, aurora)
        val plain = assertNotNull(plan(journey(), art = noEffect, reduced = true))
        assertFalse(playback.startResident(journey(), plain, 0L, admitted))
    }

    // ---- N-C5 RESIDENCY: the checked arming gate (predecessor → ONE ticket), at the actual seam ----
    @Test fun `RESIDENCY arming gate - a predecessor-checked arm issues ONE ticket and a revoke before, while or after arming refuses the install without any re-sampling`() {
        val playback = FleetJourneyPlayback()
        // The preparation is authorized under this predecessor (captured at publication). Cancel BEFORE arming: stale.
        val predecessor = playback.lifetime(); playback.revoke()
        assertNull(playback.arm(art, predecessor), "a revoke after authorization makes the delivery stale")
        assertNull(playback.admission()); assertFalse(playback.install(scene(), 1L, null, predecessor), "the old predecessor is no ticket")
        // Only a FRESH preparation (new predecessor) can arm again; its ticket installs.
        val fresh = playback.lifetime(); val ticket = assertNotNull(playback.arm(art, fresh))
        assertNull(playback.admission(), "no admission exists between arming and the install"); assertEquals(fresh + 1, ticket)
        assertTrue(playback.install(scene(), 2L, null, ticket)); assertSame(art, assertNotNull(playback.admission()).art)
        // Cancel AFTER arming (between stage and activation): the carried ticket is void; waiting frames never re-sample.
        val second = assertNotNull(playback.arm(art, playback.lifetime())); playback.revoke()
        assertFalse(playback.install(scene(), 3L, null, second)); assertNull(playback.admission())
        // (A freshly sampled lifetime WOULD install here — which is exactly why the renderer carries the arming ticket
        //  with the staged delivery and never re-samples; that orchestration is the renderer's, not this gate's.)
        // Waiting frames WITHOUT a revoke: the same ticket, unchanged, installs later.
        val third = assertNotNull(playback.arm(art, playback.lifetime())); repeat(3) { assertNull(playback.admission()) }
        assertTrue(playback.install(scene(), 4L, null, third))
        // Arming ends running flights; a competing art change after arming voids the ticket; a consumed predecessor is stale.
        val admitted = assertNotNull(playback.admission()); val plan = assertNotNull(plan(journey()))
        assertTrue(playback.startResident(journey(), plan, 0L, admitted)); assertTrue(playback.isActive())
        val before = playback.lifetime(); val fourth = assertNotNull(playback.arm(art, before))
        assertFalse(playback.isActive(), "arming ends every flight"); assertNull(playback.admission())
        assertNull(playback.arm(art, before), "a predecessor already consumed by an arm is stale")
        playback.replaceArt(Fixture(mapOf("starter" to starterTrack), craft, gate, wakeArt, aurora))
        assertFalse(playback.install(scene(), 5L, null, fourth), "an art change competing with arming voids the ticket")
        assertNull(playback.admission())
    }

    @Test fun `RESIDENCY R2 gate - a request-time predecessor refuses a delivery cancelled while preparing, ground reprepare re-arms only from the armed ticket, and the insertion gate re-reads eligibility live`() {
        val playback = FleetJourneyPlayback()
        // REQUEST (renderer submitBase): the old admission ends under the gate and the preparation is authorized by the lifetime read next.
        fun request(): Long { playback.revoke(); return playback.lifetime() }
        // 1. Request → preparation HELD → revoke (cancelFleetJourneys) → publication/arm with the request's predecessor: refused for good.
        val held = request(); playback.revoke() /* cancellation while the worker is still preparing */
        assertNull(playback.arm(art, held), "the cancelled preparation's publication arms nothing"); assertNull(playback.admission())
        assertFalse(playback.install(scene(), 1L, null, held)); assertFalse(playback.install(scene(), 1L, null, playback.lifetime() - 1))
        val fresh = request(); val ticket = assertNotNull(playback.arm(art, fresh)); assertTrue(playback.install(scene(), 2L, null, ticket))
        // 2. Ground-only reprepare of the ARMED delivery: its re-publication carries the armed ticket as predecessor.
        val reprepared = assertNotNull(playback.arm(art, ticket), "still current → a NEW ticket, never fresh authority"); assertNotEquals(ticket, reprepared)
        assertTrue(playback.install(scene(), 2L, null, reprepared)); assertSame(art, assertNotNull(playback.admission()).art)
        playback.revoke() // cancellation across the reprepare boundary
        assertNull(playback.arm(art, reprepared), "the armed ticket was revoked: the reprepared delivery arms nothing"); assertNull(playback.admission())
        assertNull(playback.arm(art, FleetJourneyPlayback.STALE_PREDECESSOR), "a delivery that never held a ticket arms nothing")
        assertFalse(playback.install(scene(), 2L, null, reprepared))
        // 3. Live recheck INSIDE the insertion gate: the same predicate the proof used, re-read immediately before flights mutate.
        val next = request(); val ticket3 = assertNotNull(playback.arm(art, next)); assertTrue(playback.install(scene(), 3L, null, ticket3))
        val admitted = assertNotNull(playback.admission()); val plan = assertNotNull(plan(journey())); val residency = assertNotNull(verifiedJourneyCells(plan, resident))
        var requestedGeneration = 3L; var sourceCurrent = true
        val live = { requestedGeneration == admitted.generation && sourceCurrent }
        requestedGeneration = 4L // a replacement was requested between proof and insertion
        assertFalse(playback.start(journey(), plan, 0L, admitted, residency, live)); assertFalse(playback.isActive())
        requestedGeneration = 3L; sourceCurrent = false // the source stopped being current between proof and insertion
        assertFalse(playback.start(journey(), plan, 0L, admitted, residency, live)); assertFalse(playback.isActive())
        sourceCurrent = true // positive current control
        assertTrue(playback.start(journey(), plan, 0L, admitted, residency, live)); assertTrue(playback.isActive(berth.id))
        // A stale re-insertion for the same berth mutates nothing: the admitted flight stays.
        requestedGeneration = 5L
        assertFalse(playback.start(journey(RenderJourneyKind.RETURN), plan, 10L, admitted, residency, live)); assertTrue(playback.isActive(berth.id))
        assertTrue(playback.sprites(berth, 20L, 0f, 32f, mutableListOf()), "the earlier admitted flight still draws")
    }

    @Test fun `RESIDENCY R3 gate - the request transition advances the generation, ends the admission and returns the authorizing predecessor as ONE step under the insertion monitor`() {
        val playback = FleetJourneyPlayback(); val generation = java.util.concurrent.atomic.AtomicLong(10L)
        var advances = 0
        // A flight is running on the installed admission when a replacement is requested.
        val armed = assertNotNull(playback.arm(art, playback.lifetime())); assertTrue(playback.install(scene(), 10L, null, armed))
        val admitted = assertNotNull(playback.admission()); val plan = assertNotNull(plan(journey()))
        assertTrue(playback.startResident(journey(), plan, 0L, admitted)); assertTrue(playback.isActive())
        val (token, predecessor) = playback.authorizeRequest({ advances++; generation.incrementAndGet() })
        assertEquals(11L, token); assertEquals(1, advances, "the generation advances exactly once, inside the transition")
        assertEquals(playback.lifetime(), predecessor, "the predecessor IS the lifetime at the end of the transition — no gap for a competing read")
        assertNull(playback.admission(), "the installed admission ended inside the same transition"); assertFalse(playback.isActive())
        assertFalse(playback.start(journey(), plan, 0L, admitted, assertNotNull(verifiedJourneyCells(plan, resident))), "nothing stale inserts after the request")
        // A competing cancellation wholly AFTER the transition makes this preparation stale; wholly BEFORE it is already accounted for.
        playback.revoke(); assertNull(playback.arm(art, predecessor), "cancelled after authorization: the publication arms nothing")
        val (token2, predecessor2) = playback.authorizeRequest({ generation.incrementAndGet() })
        assertEquals(12L, token2); assertEquals(playback.lifetime(), predecessor2)
        val ticket = assertNotNull(playback.arm(art, predecessor2), "the cancellation before this request is folded into its predecessor"); assertTrue(playback.install(scene(), token2, null, ticket))
        // The transition is the insertion gate's own monitor: a flight admitted under the new generation plays until the NEXT request.
        val fresh = assertNotNull(playback.admission()); assertTrue(playback.startResident(journey(), plan, 0L, fresh)); assertTrue(playback.isActive())
        playback.authorizeRequest({ generation.incrementAndGet() }); assertFalse(playback.isActive()); assertNull(playback.admission())
    }

    // ---- CONTINUITY: an already running original survives a benign same-installation refresh through the PRODUCTION path ----
    private fun proof(id: String = "inst-1", building: RenderBuilding = berth, baseId: String? = "base-1", rows: Boolean = true) =
        scene(baseId, building).copy(services = facts.copy(currentFleetIdentity = if (rows) listOf(RenderFleetInstallationIdentity(berth.id, id, "starter", null)) else null))
    private fun runningFlight(): FleetJourneyPlayback {
        val playback = FleetJourneyPlayback(); val admission = installed(playback, generation = 1L); val j = journey()
        assertTrue(playback.startResident(j, assertNotNull(plan(j)), 1_000L, admission)); return playback
    }

    @Test fun `continuity cannot rebind without owned fleet assets`() {
        val playback = runningFlight(); val next = proof()
        val (token, predecessor) = playback.authorizeRequest({ 2L }) { j, startedOn -> journeyContinuity(next, j, startedOn) }
        assertNull(playback.admission()); assertTrue(playback.isActive(berth.id))
        val ticket = assertNotNull(playback.arm(art, predecessor))
        assertTrue(playback.install(next, token, null, ticket, resident))
        assertFalse(playback.isActive(), "synthetic cells alone do not prove source/capability ownership; positive continuity uses real prepared assets")
    }

    @Test fun `continuity refuses other installation, moved berth, other base, no identity, lost cells, changed art, revoke and stale arm`() {
        for (next in listOf(proof("inst-2"), proof(building = berth.copy(tileX = 11f)), proof(baseId = "base-2"), proof(rows = false))) {
            val playback = runningFlight(); playback.authorizeRequest({ 2L }) { j, b -> journeyContinuity(next, j, b) }
            assertFalse(playback.isActive(), "ended before preparation: ${'$'}{next.services.currentFleetIdentity} ${'$'}{next.baseId}")
        }
        run { val playback = runningFlight(); val next = proof(); val (token, predecessor) = playback.authorizeRequest({ 2L }) { j, b -> journeyContinuity(next, j, b) }
            assertTrue(playback.install(next, token, null, assertNotNull(playback.arm(art, predecessor)), listOf(cosmeticsAtlas)), "install succeeds")
            assertFalse(playback.isActive(), "the fresh resident set lacks the craft cells: the whole original drops") }
        run { val playback = runningFlight(); val next = proof(); val (token, predecessor) = playback.authorizeRequest({ 2L }) { j, b -> journeyContinuity(next, j, b) }
            val replaced = Fixture(mapOf("starter" to starterTrack), craft, gate, wakeArt, aurora)
            assertTrue(playback.install(next, token, null, assertNotNull(playback.arm(replaced, predecessor)), resident))
            assertFalse(playback.isActive(), "a changed art capability never rebinds an old plan") }
        run { val playback = runningFlight(); val next = proof(); val (_, predecessor) = playback.authorizeRequest({ 2L }) { j, b -> journeyContinuity(next, j, b) }
            playback.revoke(); assertFalse(playback.isActive(), "pause/battle/source revoke ends preserved originals"); assertNull(playback.arm(art, predecessor)) }
        run { val playback = runningFlight(); val next = proof(); val (_, predecessor) = playback.authorizeRequest({ 2L }) { j, b -> journeyContinuity(next, j, b) }
            assertNull(playback.arm(art, predecessor - 1)); assertTrue(playback.isActive(), "a superseded arm must leave the current request intact"); assertNotNull(playback.arm(art, predecessor)) }
        // the pure proof itself
        assertTrue(journeyContinuity(proof(), journey(), berth)); assertFalse(journeyContinuity(proof(), journey(family = "survey_balloon", tier = 1), berth))
        assertFalse(journeyContinuity(proof(), journey(berthId = "berth-2"), berth)); assertFalse(journeyContinuity(proof(building = berth.copy(level = 0)), journey(), berth))
    }
    @Test fun `current logical delivery can commit without optional fleet admission`() {
        val playback = FleetJourneyPlayback(); val generation = java.util.concurrent.atomic.AtomicLong(0L)
        val request = playback.authorizeRequest({ generation.incrementAndGet() })
        var logicalScene: BaseScene? = null
        assertTrue(playback.commitDelivery({ assertTrue(Thread.holdsLock(playback)); request.first == generation.get() }) {
            logicalScene = scene() // renderer's null-ticket/battle fallback still installs its logical scene.
            assertTrue(playback.revokeDelivery(request.first) { generation.get() })
        })
        assertNotNull(logicalScene); assertNull(playback.admission()); assertFalse(playback.isActive())
        assertFalse(playback.install(scene(), request.first, null, request.second), "the dropped optional ticket cannot later revive")
    }

}
