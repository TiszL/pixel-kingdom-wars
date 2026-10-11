package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import kotlin.test.*

/** Renderer17 fleet art against the AUTHENTIC generated sidecars (test-fixtures/fleet-journeys, byte-exact
 *  copies of the primary web fixtures) inside the tracked renderer16 candidate catalogue relabelled 17 with
 *  a SYNTHETIC fleet block (synthetic atlas pins only; no candidate directory, no PNGs). Proves the strict
 *  parse, the concrete adapter's exact authored geometry/tracks/stills/Wake, resolve-once atlas identity,
 *  the accepted R1 consumer playing the real starter metadata, every refusal, and that the global
 *  catalogue admission still rejects 17. Metadata only: nothing claims installed pixels. */
class PhaseEFleetArtTest {
    private val fixtures = File("../test-fixtures/fleet-journeys")
    private val families = listOf("survey-balloon", "cargo-cutter", "courier-airship", "expedition-barge")
    private val groupIds = (listOf("pe_fleet_starter") + families.map { it.replace('-', '_') }.flatMap { f -> listOf("pe_berth_$f") + (1..4).map { "pe_veh_${f}_t$it" } }).sorted()
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
    private fun sidecar(name: String, pin: String): JsonValue {
        val bytes = File(fixtures, name).readBytes(); assertEquals(pin, sha(bytes), "tracked $name is the authored sidecar"); return JsonReader().parse(String(bytes, Charsets.UTF_8))
    }
    private fun starterTable() = sidecar("pe_fleet_starter.manifest.json", "14b400ca96c252619e251aaf2e596430179788a9371a0a6c30d58f84834fe510")
    private fun advancedTable() = sidecar("pe_advanced_fleet.manifest.json", "fde4e84867e56b09bdfc10feff287ae76f01644546a061e99fd3af85a2c19299")
    private fun obj() = JsonValue(JsonValue.ValueType.`object`)
    private fun str(v: String) = JsonValue(v)
    private fun num(v: Long) = JsonValue(v)
    /** The renderer16 candidate, contract relabelled to [contract], plus the fleet block (mutable before parse). */
    private fun root17(contract: Any = 17L, mutate: (JsonValue) -> Unit = {}): JsonValue {
        val root = JsonReader().parse(CosmeticsCandidateFixture.renderCatalogueText())
        when (contract) { is Long -> root.get("rendererContractVersion").set(contract, null); is Double -> root.get("rendererContractVersion").set(contract, null); else -> root.get("rendererContractVersion").set(contract.toString()) }
        val fleet = obj(); fleet.addChild("version", num(1))
        val metadata = obj(); metadata.addChild("peStarterFleet", starterTable()); metadata.addChild("peAdvancedFleet", advancedTable()); fleet.addChild("metadata", metadata)
        val groups = JsonValue(JsonValue.ValueType.array)
        for (id in groupIds) {
            val g = obj(); g.addChild("id", str(id)); g.addChild("atlasPath", str("atlas/$id@1x.json")); g.addChild("imagePath", str("atlas/$id@1x.png")); g.addChild("decodedBytes", num(4096))
            val files = JsonValue(JsonValue.ValueType.array)
            for (path in listOf("atlas/$id@1x.json", "atlas/$id@1x.png")) { val pin = obj(); pin.addChild("path", str(path)); pin.addChild("sha256", str("0".repeat(64))); pin.addChild("size", num(1)); files.addChild(pin) }
            g.addChild("files", files); groups.addChild(g)
        }
        fleet.addChild("groups", groups); fleet.addChild("sourceCommit", str("a".repeat(40)))
        root.addChild("fleetJourneys", fleet); mutate(root); return root
    }
    private fun art(mutate: (JsonValue) -> Unit = {}) = PhaseEFleetArt.parse(root17(mutate = mutate))
    private fun starter(root: JsonValue) = root.get("fleetJourneys").get("metadata").get("peStarterFleet")
    private fun advanced(root: JsonValue) = root.get("fleetJourneys").get("metadata").get("peAdvancedFleet")
    private fun steps(vararg rows: Triple<Int, Pair<Float, Float>, Float>) = rows.map { JourneyStep(it.first, ServicePoint(it.second.first, it.second.second), it.third) }
    private val tidalDeparture = steps(Triple(0, 0f to 0f, 1f), Triple(1, 0f to -4f, 1f), Triple(2, 0f to -10f, 1f), Triple(3, 0f to -16f, 1f),
        Triple(4, 0f to -22f, .85f), Triple(5, 0f to -28f, .5f), Triple(6, 0f to -34f, .15f), Triple(7, 0f to -40f, 0f))

    @Test fun `renderer17 candidate parses the complete fleet graph on top of the untouched service and cosmetics graphs`() {
        val fleet = art()
        assertEquals(11 + 80, fleet.clips.size); assertEquals(42 + 268, fleet.clips.values.sumOf { it.frames.size })
        assertEquals(setOf("starter") + families, fleet.berths.keys); assertEquals(setOf("starter") + families, fleet.tracks.keys)
        assertEquals(1 + 16, fleet.vehicles.size); assertEquals(groupIds.toSet(), fleet.groups.keys)
        assertEquals(setOf(RenderJourneyKind.DEPARTURE, RenderJourneyKind.RETURN), fleet.gateEffects.keys); assertEquals(fleet.gateEffects.keys, fleet.gateStills.keys)
        assertNotNull(fleet.services.cosmetics, "17 carries the renderer16 cosmetics"); assertEquals(46 + 1, fleet.services.groups.size, "service groups untouched")
        assertEquals("a".repeat(40), fleet.sourceCommit); assertNull(fleet.basePack)
        assertEquals("ec25edf57184bff954bd6d9861bd9bc87db302a23bd677a06de720b1efe09d83", fleet.starterBindingSha256)
        assertEquals("c2de5bfaf3c6d9e5700c613ae6aea0eeb9a57f9a8f055dde08db38402c80a329", fleet.sourceManifestSha256)
        // Berth and craft geometry are the authored numbers; the dock translation equals attachment − contact.
        val berth = fleet.berths.getValue("starter").geometry; val craft = fleet.vehicles.getValue("starter").geometry
        assertEquals(ServicePoint(56f, 78f), berth.attachment); assertEquals(ServicePoint(56f, 28f), berth.tidalGate); assertEquals(ServicePoint(56f, 93f), berth.groundContact)
        assertEquals(ServicePoint(56f, 105f), craft.contactPx); assertEquals(ServicePoint(0f, -27f), craft.dockOffsetPx)
        assertEquals(ServicePoint(berth.attachment.x - craft.contactPx.x, berth.attachment.y - craft.contactPx.y), craft.dockOffsetPx)
        for (family in families) {
            val b = fleet.berths.getValue(family).geometry
            assertEquals(if (family in setOf("cargo-cutter", "expedition-barge")) ServicePoint(56f, 28f) else null, b.tidalGate, family)
            for (tier in 1..4) { val v = fleet.vehicles.getValue("$family:$tier"); assertEquals(tier, v.tier); assertEquals(ServicePoint(b.attachment.x - v.geometry.contactPx.x, b.attachment.y - v.geometry.contactPx.y), v.geometry.dockOffsetPx, "$family t$tier") }
        }
        assertFailsWith<UnsupportedOperationException> { (fleet.clips as MutableMap<String, FleetClip>).clear() }
        assertFailsWith<UnsupportedOperationException> { (fleet.tracks.getValue("starter").departure as MutableList<JourneyStep>).clear() }
    }

    @Test fun `starter adapter is the authored track, docked craft on its contact, and the gate effects with their SEPARATE stills`() {
        val journey = art().journeyArt()
        val track = assertNotNull(journey.track("starter"))
        assertEquals(8f, track.fps); assertEquals(tidalDeparture, track.departure); assertEquals(tidalDeparture.reversed().mapIndexed { i, s -> JourneyStep(i, s.offsetPx, s.opacity) }, track.back)
        assertEquals(ServicePoint(56f, 28f), track.effectAttachmentPx, "gate effect sits on the authored tidal gate"); assertEquals("departure", track.sharedFxRef)
        val craft = assertNotNull(journey.vehicle("starter", null))
        assertEquals("atlas/pe_fleet_starter@1x.json", craft.atlasPath); assertEquals((1..4).map { "pe_veh_starter_docked_f$it" }, craft.frames); assertEquals(8f, craft.fps)
        assertEquals(ServicePoint(112f, 112f), craft.cell); assertEquals(ServicePoint(56f, 105f), craft.contactPx); assertEquals(ServicePoint(0f, -27f), craft.dockOffsetPx)
        assertNull(journey.vehicle("starter", 1), "the starter has no tier"); assertNull(journey.track("starter_x")); assertNull(journey.vehicle("pe_veh_starter", null))
        for ((kind, name) in listOf(RenderJourneyKind.DEPARTURE to "departure", RenderJourneyKind.RETURN to "return")) {
            val fx = assertNotNull(journey.gateEffect(kind))
            assertEquals("atlas/pe_fleet_starter@1x.json", fx.atlasPath); assertEquals((1..8).map { "pe_fx_${name}_f$it" }, fx.frames); assertEquals(8f, fx.fps); assertEquals(ServicePoint(64f, 64f), fx.cell)
            assertEquals("pe_fx_${name}_still_f1", fx.still); assertFalse(fx.still in fx.frames, "the still is its own packed frame, never a member of the eight")
        }
        assertFailsWith<UnsupportedOperationException> { (craft.frames as MutableList<String>).clear() }
        assertFailsWith<UnsupportedOperationException> { (track.departure as MutableList<JourneyStep>).clear() }
    }

    @Test fun `advanced adapters cover all four families and tiers with exact dock anchoring, dash names only - underscore wire names resolve nothing`() {
        val fleet = art(); val journey = fleet.journeyArt()
        for (family in families) {
            val group = family.replace('-', '_'); val berth = fleet.berths.getValue(family).geometry
            val track = assertNotNull(journey.track(family))
            if (family in setOf("cargo-cutter", "expedition-barge")) { assertEquals("departure", track.sharedFxRef); assertEquals(ServicePoint(56f, 28f), track.effectAttachmentPx); assertEquals(tidalDeparture, track.departure) }
            else { assertNull(track.sharedFxRef, "vertical lift-off has no gate effect"); assertEquals(ServicePoint(56f, 40f), track.effectAttachmentPx); assertEquals(ServicePoint(0f, -78f), track.departure.last().offsetPx); assertEquals(0f, track.departure.last().opacity) }
            assertEquals(8, track.departure.size); assertEquals(8, track.back.size); assertEquals(8f, track.fps)
            for (tier in 1..4) {
                val craft = assertNotNull(journey.vehicle(family, tier), "$family t$tier")
                assertEquals("atlas/pe_veh_${group}_t$tier@1x.json", craft.atlasPath); assertEquals((1..4).map { "pe_veh_${group}_t${tier}_docked_f$it" }, craft.frames)
                assertEquals(fleet.vehicles.getValue("$family:$tier").geometry.contactPx, craft.contactPx)
                assertEquals(ServicePoint(berth.attachment.x - craft.contactPx.x, berth.attachment.y - craft.contactPx.y), craft.dockOffsetPx, "translation = attachment − contact")
            }
            assertNull(journey.vehicle(family, null)); assertNull(journey.vehicle(family, 5)); assertNull(journey.vehicle(group, 1)); assertNull(journey.track(group))
        }
        assertEquals(ServicePoint(56f, 110f), assertNotNull(journey.vehicle("survey-balloon", 1)).contactPx); assertEquals(ServicePoint(0f, -54f), journey.vehicle("survey-balloon", 1)!!.dockOffsetPx)
        assertEquals(ServicePoint(0f, -50f), assertNotNull(journey.vehicle("courier-airship", 4)).dockOffsetPx)
    }

    @Test fun `Wake art only when all three captured hashes equal the carried cosmetics binding`() {
        val fleet = art(); val journey = fleet.journeyArt(); val binding = assertNotNull(fleet.services.cosmetics).wakeBinding
        val wake = assertNotNull(journey.wake(RenderJourneyWake.Available("aurora_wake", binding.sha256, binding.sourceManifestSha256, binding.sourceIndexSha256)))
        assertEquals("atlas/pe_cosmetics@1x.json", wake.atlasPath); assertEquals((1..8).map { "pe_cos_wake_f$it" }, wake.frames); assertEquals(8f, wake.fps); assertEquals(ServicePoint(64f, 64f), wake.cell)
        val clip = fleet.services.cosmetics!!.clips.getValue("pe_cos_wake"); assertEquals(clip.frames[(clip.reducedMotion as ServiceReducedMotion.Frame).index].key, wake.still)
        assertNull(journey.wake(RenderJourneyWake.Available("aurora_wake", "f".repeat(64), binding.sourceManifestSha256, binding.sourceIndexSha256)), "binding hash")
        assertNull(journey.wake(RenderJourneyWake.Available("aurora_wake", binding.sha256, "0".repeat(64), binding.sourceIndexSha256)), "manifest hash")
        assertNull(journey.wake(RenderJourneyWake.Available("aurora_wake", binding.sha256, binding.sourceManifestSha256, "1".repeat(64))), "index hash")
        val awning = fleet.services.cosmetics!!.bindings.getValue("artisan_market_awning_t1")
        assertNull(journey.wake(RenderJourneyWake.Available("artisan_market_awning_t1", awning.sha256, awning.sourceManifestSha256, awning.sourceIndexSha256)), "only the Aurora Wake output")
    }

    @Test fun `atlas identity resolves ONCE at adapter creation - a missing, blank or ambiguous answer gives that group no art`() {
        val fleet = art(); var calls = 0
        val journey = fleet.journeyArt { group -> calls++; "/resident/${group.id}" }
        assertEquals(21 + 1, calls, "every fleet group and the cosmetics group, once each, at creation")
        assertEquals("/resident/pe_fleet_starter", assertNotNull(journey.vehicle("starter", null)).atlasPath)
        assertEquals("/resident/pe_veh_cargo_cutter_t2", assertNotNull(journey.vehicle("cargo-cutter", 2)).atlasPath)
        assertEquals("/resident/pe_fleet_starter", assertNotNull(journey.gateEffect(RenderJourneyKind.RETURN)).atlasPath)
        val binding = fleet.services.cosmetics!!.wakeBinding
        assertEquals("/resident/pe_cosmetics", assertNotNull(journey.wake(RenderJourneyWake.Available("aurora_wake", binding.sha256, binding.sourceManifestSha256, binding.sourceIndexSha256))).atlasPath)
        assertEquals(22, calls, "no lazy resolution per lookup")
        val partial = fleet.journeyArt { group -> if (group.id == "pe_fleet_starter") null else group.atlasPath }
        assertNull(partial.vehicle("starter", null)); assertNull(partial.gateEffect(RenderJourneyKind.DEPARTURE)); assertNotNull(partial.vehicle("survey-balloon", 1)); assertNotNull(partial.track("starter"), "tracks are data, not atlas art")
        val blank = fleet.journeyArt { " " }; assertNull(blank.vehicle("starter", null)); assertNull(blank.vehicle("expedition-barge", 3))
        val ambiguous = fleet.journeyArt { "/resident/one" }
        assertNull(ambiguous.vehicle("starter", null)); assertNull(ambiguous.vehicle("courier-airship", 1)); assertNull(ambiguous.gateEffect(RenderJourneyKind.DEPARTURE))
        assertNull(ambiguous.wake(RenderJourneyWake.Available("aurora_wake", binding.sha256, binding.sourceManifestSha256, binding.sourceIndexSha256)))
    }

    @Test fun `the accepted R1 consumer plays the real starter metadata - advanced consumption stays held`() {
        val fleet = art(); val journeyArt = fleet.journeyArt()
        val berth = RenderBuilding("berth-1", "service:berth:1", 10f, 8f, 2f, 2f, type = "berth", level = 1, service = RenderServiceIdentity("berth", null))
        val facts = RenderServiceFacts(true, berths = listOf(RenderBerthPresentation(berth.id, RenderStarterInstallation("starter", RenderStarterPresence.OCCUPIED))))
        val binding = fleet.services.cosmetics!!.wakeBinding
        val aurora = RenderJourneyWake.Available("aurora_wake", binding.sha256, binding.sourceManifestSha256, binding.sourceIndexSha256)
        fun journey(kind: RenderJourneyKind = RenderJourneyKind.DEPARTURE, family: String = "starter", tier: Int? = null, wake: RenderJourneyWake = RenderJourneyWake.Legacy) =
            RenderFleetJourney("$kind:$family:e1", kind, "base-1", berth.id, "inst-1", RenderJourneyVehicle(family, tier), wake)
        val plan = assertNotNull(selectJourneyPlan(journeyArt, berth, facts, journey(wake = aurora), reducedMotion = false))
        assertEquals(tidalDeparture, plan.steps); assertEquals(8f, plan.fps); assertEquals(1000f, plan.durationMs)
        assertEquals((1..4).map { "pe_veh_starter_docked_f$it" }, plan.vehicle.frames); assertEquals("pe_fx_departure_still_f1", assertNotNull(plan.effect).still)
        assertEquals(ServicePoint(56f, 28f), plan.effectAttachmentPx); assertEquals("atlas/pe_cosmetics@1x.json", assertNotNull(plan.wake).atlasPath)
        assertEquals(setOf("atlas/pe_fleet_starter@1x.json", "atlas/pe_cosmetics@1x.json"), plan.atlasPaths)
        // Residency against the authored cell inventory: every normal key AND the separate still resolve.
        val cells = { group: String, keys: List<String> -> JourneyResidentAtlas("atlas/$group@1x.json", keys.associateWith { ServicePackedCell("$group.png", 0, 0, 64, 64) }) }
        val resident = listOf(cells("pe_fleet_starter", fleet.clips.values.filter { it.group == "pe_fleet_starter" }.flatMap { it.keys }), cells("pe_cosmetics", (1..8).map { "pe_cos_wake_f$it" }))
        val residency = assertNotNull(verifiedJourneyCells(plan, resident))
        assertTrue("pe_fx_departure_still_f1" in assertNotNull(residency.effect)); assertEquals(8 + 1, residency.effect!!.size); assertEquals(4, residency.vehicle.size); assertEquals(8, assertNotNull(residency.wake).size)
        assertNull(verifiedJourneyCells(plan, listOf(cells("pe_fleet_starter", fleet.clips.values.filter { it.group == "pe_fleet_starter" }.flatMap { it.keys } - "pe_fx_departure_still_f1"), resident[1])), "a missing separate still drops")
        // Playback: the craft contact sits at seat + dock + contact − berth pivot at step 0, Wake under it, gate effect on the tidal gate.
        val playback = FleetJourneyPlayback(); playback.replaceArt(journeyArt)
        val scene = BaseScene(listOf(berth), columns = 12, rows = 12, tilePixels = 32f, baseId = "base-1", services = facts)
        assertTrue(playback.install(scene, 1L, null, playback.lifetime())); val admission = assertNotNull(playback.admission())
        assertTrue(playback.start(journey(wake = aurora), plan, 0L, admission, residency))
        val out = mutableListOf<JourneySprite>(); assertTrue(playback.sprites(berth, 0L, 0f, 32f, out))
        val seatX = (10f + 1f) * 32f; val seatY = (8f + 2f) * 32f
        val craft = out.single { it.sprite.clip.key == "journey-craft" }; assertEquals(seatX + 0f + 56f - 56f, craft.sprite.x); assertEquals(seatY - 27f + 105f - 112f, craft.sprite.y); assertEquals(1f, craft.alpha)
        val wake = out.single { it.sprite.clip.key == "journey-wake" }; assertEquals(craft.sprite.x to craft.sprite.y, wake.sprite.x to wake.sprite.y)
        val fx = out.single { it.sprite.clip.key == "journey-effect" }; assertEquals(seatX + 56f - 56f, fx.sprite.x); assertEquals(seatY + 28f - 112f, fx.sprite.y)
        out.clear(); assertTrue(playback.sprites(berth, 625L, 0f, 32f, out)); assertEquals(.5f, out.single { it.sprite.clip.key == "journey-craft" }.alpha, "authored opacity at step 5")
        // Reduced motion: the separately authored still only, for the track duration.
        val reduced = assertNotNull(selectJourneyPlan(journeyArt, berth, facts, journey(), reducedMotion = true)); assertEquals("pe_fx_departure_still_f1", reduced.effect?.still)
        val still = FleetJourneyPlayback(); still.replaceArt(journeyArt); assertTrue(still.install(scene, 1L, null, still.lifetime()))
        assertTrue(still.start(journey(), reduced, 0L, assertNotNull(still.admission()), assertNotNull(verifiedJourneyCells(reduced, resident))))
        out.clear(); assertTrue(still.sprites(berth, 10L, 0f, 32f, out)); assertEquals(listOf("pe_fx_departure_still_f1"), out.map { it.sprite.frameKey })
        // The return plays the return effect with ITS separate still.
        assertEquals("pe_fx_return_still_f1", assertNotNull(selectJourneyPlan(journeyArt, berth, facts, journey(RenderJourneyKind.RETURN), reducedMotion = false)).effect?.still)
        // Advanced art is parsed and adaptable, but the consumer's selection stays starter-only until typed facts exist.
        assertNotNull(journeyArt.vehicle("survey-balloon", 1))
        assertNull(selectJourneyPlan(journeyArt, berth, facts, journey(family = "survey_balloon", tier = 1), reducedMotion = false), "advanced journeys are HELD")
        assertNull(selectJourneyPlan(journeyArt, berth, facts, journey(family = "survey-balloon", tier = 1), reducedMotion = false))
    }

    @Test fun `malformed, incomplete or foreign fleet data refuses the whole graph`() {
        assertNotNull(art(), "baseline parses")
        assertFails("contract 16 is not fleet art") { PhaseEFleetArt.parse(root17(contract = 16L)) }
        assertFails("17.5 is not the exact integer") { PhaseEFleetArt.parse(root17(contract = 17.5)) }
        assertFails("\"17\" is not a number") { PhaseEFleetArt.parse(root17(contract = "17")) }
        assertFails("no fleet block") { PhaseEFleetArt.parse(root17 { it.remove("fleetJourneys") }) }
        assertFails("17 needs the cosmetics") { PhaseEFleetArt.parse(root17 { it.remove("boundCosmetics") }) }
        assertFails("17 needs the service graph") { PhaseEFleetArt.parse(root17 { it.remove("phaseE") }) }
        fun refuse(name: String, mutate: (JsonValue) -> Unit) = name to mutate
        val refusals = listOf(
            refuse("fleet version") { r -> r.get("fleetJourneys").get("version").set(2L, null) },
            refuse("a missing group") { r -> r.get("fleetJourneys").get("groups").remove(0) },
            refuse("an extra group") { r -> val g = r.get("fleetJourneys").get("groups"); val copy = JsonReader().parse(g.get(0).toJson(JsonWriter.OutputType.json)); copy.get("id").set("pe_fx"); g.addChild(copy) },
            refuse("a duplicated group") { r -> val g = r.get("fleetJourneys").get("groups"); g.get(1).get("id").set(g.get(0).getString("id")) },
            refuse("a group colliding with the cosmetics group") { r -> val g = r.get("fleetJourneys").get("groups").get(0); g.get("id").set("pe_cosmetics"); g.get("atlasPath").set("atlas/pe_cosmetics@1x.json"); g.get("imagePath").set("atlas/pe_cosmetics@1x.png") },
            refuse("a group atlas path elsewhere") { r -> r.get("fleetJourneys").get("groups").get(0).get("atlasPath").set("atlas/other@1x.json") },
            refuse("an unpaired pin") { r -> r.get("fleetJourneys").get("groups").get(0).get("files").remove(1) },
            refuse("a short source commit") { r -> r.get("fleetJourneys").get("sourceCommit").set("abc") },
            refuse("an unknown fleet key") { r -> r.get("fleetJourneys").addChild("extra", num(1)) },
            refuse("a starter table packed elsewhere") { r -> starter(r).get("atlas").set("pe_fleet_other") },
            refuse("a dock translation differing from attachment − contact") { r -> starter(r).get("geometry").get("starter").get("dockOffsetPx").get(1).set(-26.0, null) },
            refuse("a berth clip geometry differing from the table") { r -> starter(r).get("clips").get("pe_berth_starter_intact").get("geometry").get("attachment").get(1).set(79.0, null) },
            refuse("a zero-based frame key") { r -> starter(r).get("clips").get("pe_veh_starter_docked").get("frames").get(0).get("key").set("pe_veh_starter_docked_f0") },
            refuse("a one-based source index") { r -> starter(r).get("clips").get("pe_veh_starter_docked").get("frames").get(0).get("sourceIndex").set(1L, null) },
            refuse("a missing separate gate still") { r -> starter(r).get("clips").get("pe_fx_return").remove("reducedMotionClip") },
            refuse("a still duplicating a normal frame digest") { r -> starter(r).get("clips").get("pe_fx_departure_still").get("frames").get(0).get("sha256").set(starter(r).get("clips").get("pe_fx_departure").get("frames").get(0).getString("sha256")) },
            refuse("a still with two frames") { r -> val f = starter(r).get("clips").get("pe_fx_return_still").get("frames"); val copy = JsonReader().parse(f.get(0).toJson(JsonWriter.OutputType.json)); copy.get("key").set("pe_fx_return_still_f2"); copy.get("sourceIndex").set(1L, null); f.addChild(copy) },
            refuse("a non-centred effect anchor") { r -> starter(r).get("clips").get("pe_fx_departure").get("anchorPx").get(0).set(31.0, null) },
            refuse("a craft anchored off its contact") { r -> starter(r).get("clips").get("pe_veh_starter_travel").get("anchorPx").get(1).set(104.0, null) },
            refuse("a track opacity above one") { r -> starter(r).get("tracks").get("families").get("starter").get("departure").get(2).get("opacity").set(1.5, null) },
            refuse("a negative track opacity") { r -> starter(r).get("tracks").get("families").get("starter").get("departure").get(2).get("opacity").set(-0.1, null) },
            refuse("an opacity that would only round into range as a Float") { r -> starter(r).get("tracks").get("families").get("starter").get("departure").get(2).get("opacity").set(1.00000001, null) },
            refuse("a non-finite track opacity") { r -> starter(r).get("tracks").get("families").get("starter").get("departure").get(2).get("opacity").set(Double.POSITIVE_INFINITY, null) },
            refuse("a fractional frame count field") { r -> starter(r).get("tracks").get("fps").set(8.5, null) },
            refuse("a track ordinal out of order") { r -> starter(r).get("tracks").get("families").get("starter").get("return").get(3).get("frame").set(4L, null) },
            refuse("an unknown shared gate effect") { r -> starter(r).get("tracks").get("families").get("starter").get("sharedFxRef").set("vortex") },
            refuse("an effect seat outside the berth cell") { r -> starter(r).get("tracks").get("families").get("starter").get("effectAttachmentPx").get(1).set(113.0, null) },
            refuse("an extra starter table key") { r -> starter(r).addChild("extra", num(1)) },
            refuse("a missing starter clip") { r -> starter(r).get("clips").remove("pe_veh_starter_idle") },
            refuse("advanced tables from another source") { r -> advanced(r).get("sourceManifestSha256").set("9".repeat(64)) },
            refuse("an advanced binding pinned to another source") { r -> advanced(r).get("bindings").get("pe_veh_cargo_cutter_t1").get("value").get("sourceIndexSha256").set("8".repeat(64)) },
            refuse("an advanced binding track differing from the family track") { r -> advanced(r).get("bindings").get("pe_berth_survey_balloon").get("value").get("track").get("departure").get(1).get("opacity").set(.9, null) },
            refuse("an advanced binding declaring another tier under its group") { r -> val v = advanced(r).get("bindings").get("pe_veh_cargo_cutter_t1").get("value"); v.get("tier").set(2L, null); v.get("sourceAssetId").set("cargo-cutter-t2") },
            refuse("an advanced binding declaring another family under its group") { r -> val v = advanced(r).get("bindings").get("pe_veh_cargo_cutter_t1").get("value"); v.get("sourceFamily").set("survey-balloon"); v.get("sourceAssetId").set("survey-balloon-t1") },
            refuse("an advanced binding declaring a berth kind under a vehicle group") { r -> val v = advanced(r).get("bindings").get("pe_veh_cargo_cutter_t1").get("value"); v.get("kind").set("berth"); v.remove("tier"); v.addChild("tier", JsonValue(JsonValue.ValueType.nullValue)); v.get("sourceAssetId").set("cargo-cutter-berth") },
            refuse("an advanced binding asset of another tier") { r -> advanced(r).get("bindings").get("pe_veh_courier_airship_t3").get("value").get("sourceAssetId").set("courier-airship-t4") },
            refuse("an advanced binding naming a clip of another group") { r -> advanced(r).get("bindings").get("pe_veh_cargo_cutter_t1").get("value").get("clips").get(0).set("pe_veh_cargo_cutter_t2_idle") },
            refuse("an advanced clip stated under another atlas") { r -> advanced(r).get("clips").get("pe_veh_survey_balloon_t3_idle").get("atlas").set("pe_veh_survey_balloon_t2") },
            refuse("an advanced dock translation disagreeing with its berth") { r -> advanced(r).get("clips").get("pe_veh_expedition_barge_t2_docked").get("geometry").get("dockOffsetPx").get(1).set(-28.0, null) },
            refuse("a renamed advanced family track") { r -> val f = advanced(r).get("tracks").get("families"); val t = f.get("cargo-cutter"); f.remove("cargo-cutter"); f.addChild("cargo_cutter", t) },
            refuse("a missing advanced atlas") { r -> advanced(r).get("atlases").remove(3) },
            refuse("a provider index disagreeing with the clip") { r -> advanced(r).get("clips").get("pe_berth_cargo_cutter_ambient").get("frames").get(2).get("providerIndex").set(9L, null) },
        )
        for ((name, mutate) in refusals) assertFails(name) { PhaseEFleetArt.parse(root17(mutate = mutate)) }
    }

    @Test fun `catalogue admits exact 17 through the accepted parser - 15 and 16 unchanged, malformed and unknown refused`() {
        // N-C5 CONTENT-MOUNT (local branch support): exact 17 is admitted ONLY through PhaseEFleetArt.parse; 16 and 15 behave as before.
        assertNotNull(RendererCatalogue.serviceArt(JsonReader().parse(CosmeticsCandidateFixture.renderCatalogueText())), "the tracked renderer16 candidate is admitted")
        val root = root17()
        val admitted = assertNotNull(RendererCatalogue.serviceArt(root), "exact 17 is admitted as metadata")
        assertNotNull(admitted.cosmetics); assertEquals(PhaseEFleetArt.parse(root17()).services.groups.size, admitted.groups.size); assertEquals(46 + 1, admitted.groups.size)
        RendererCatalogue.validate(root) // the whole catalogue admission (static, combat envelope, walls, ground, camps) accepts the synthetic 17 root
        assertFails("17.5 is not exact") { RendererCatalogue.serviceArt(root17(contract = 17.5)) }
        assertFails("\"17\" is not a number") { RendererCatalogue.serviceArt(root17(contract = "17")) }
        assertFails("18 is unknown") { RendererCatalogue.serviceArt(root17(contract = 18L)) }
        assertFails("17 without its fleet block is malformed") { RendererCatalogue.serviceArt(root17 { it.remove("fleetJourneys") }) }
        assertFails("17 without cosmetics is malformed") { RendererCatalogue.validate(root17 { it.remove("boundCosmetics") }) }
        // The EXACT accepted candidate17 fixture (root-owned, read-only; digest-checked) passes WHOLE RendererCatalogue validation.
        val gz = java.io.File("../test-fixtures/candidate-6f7a9e81-sim18-r17-fleet/render-catalog.json.gz")
        val bytes = java.util.zip.GZIPInputStream(gz.inputStream()).use { it.readBytes() }
        assertEquals("f9eff00c5a8119e3aed0675d816ba5371d1634332f36a398b570c1c488988133", sha(bytes), "the exact candidate17 render bytes")
        val exact = JsonReader().parse(String(bytes, Charsets.UTF_8))
        RendererCatalogue.validate(exact)
        val exactArt = assertNotNull(RendererCatalogue.serviceArt(exact)); assertNotNull(exactArt.cosmetics); assertEquals(47, exactArt.groups.size)
        assertEquals(21, PhaseEFleetArt.parse(exact).groups.size)
    }
}
