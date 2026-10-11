package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import kotlin.test.*

/** N-C5 RESIDENCY: selected fleet groups prepared through the EXISTING current-Home service-assets path with a
 *  PRIVATE pinned-group source fixture — the tracked renderer16 candidate catalogue (CosmeticsCandidateFixture) and
 *  the authentic fleet sidecars (test-fixtures/fleet-journeys), re-pinned IN MEMORY to header-only atlas files written
 *  under a temporary folder (no PNG pixels, no candidate pack directory, no generated pack). These cases prove group
 *  selection, the combined budget, exact canonical resident identity, the per-generation adapter, refusals and cleanup.
 *  They are neither generated-pack validation nor GL/Android pixels, and current15 production stays inert. */
class FleetJourneyResidencyTest {
    @get:Rule val temporary = TemporaryFolder()
    private val fixtures = File("../test-fixtures/fleet-journeys")
    private val families = listOf("survey_balloon", "cargo_cutter", "courier_airship", "expedition_barge")
    private val fleetGroupIds = (listOf("pe_fleet_starter") + families.flatMap { f -> listOf("pe_berth_$f") + (1..4).map { "pe_veh_${f}_t$it" } })
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
    private fun sidecar(name: String, pin: String): JsonValue { val bytes = File(fixtures, name).readBytes(); assertEquals(pin, sha(bytes)); return JsonReader().parse(String(bytes, Charsets.UTF_8)) }

    /** One private pinned-group source: [present] groups are served from [root]; everything else is unavailable. */
    private class Source(val root: File, val present: Set<String>) : ServiceAssetSource {
        val acquired = mutableListOf<String>(); val released = mutableListOf<String>(); var current = true; var failAfter = Int.MAX_VALUE
        override fun isCurrent() = current
        override fun acquire(group: String, checkpoint: () -> Unit): ServiceAssetLease {
            acquired += group; require(group in present) { "not pinned: $group" }
            if (acquired.size > failAfter) current = false
            checkpoint()
            return ServiceAssetLease(FileHandle(root)) { released += group }
        }
        override fun cancelPending() = Unit
    }
    private class Fixture(val serviceArt: PhaseEServiceArt, val capability: PhaseEFleetArt, val root: File, val sizes: Map<String, Pair<Int, Int>>, val pinnedText: String) {
        fun decode(file: FileHandle): ServiceTexturePixels { val (w, h) = sizes.getValue(file.name()); return serviceTestPixels(w, h) }
        /** Another capability parsed from the SAME pinned catalogue text after [mutate]: same groups, sizes and synthetic bytes, differing only where mutated. */
        fun variant(mutate: (JsonValue) -> Unit): PhaseEFleetArt { val root = JsonReader().parse(pinnedText); mutate(root); return PhaseEFleetArt.parse(root) }
        val allGroups: Set<String> get() = sizes.keys.map { it.removeSuffix("@1x.png") }.toSet()
        fun canonical(group: String) = File(root, "atlas/$group@1x.json").canonicalPath
        val aurora: RenderJourneyWake.Available get() = capability.services.cosmetics!!.wakeBinding.let { RenderJourneyWake.Available("aurora_wake", it.sha256, it.sourceManifestSha256, it.sourceIndexSha256) }
    }

    /** Header-only atlas pair for [cells] under [root], returning the canvas size; the JSON pin fields are set by the caller. */
    private fun writeAtlas(root: File, id: String, cells: Map<String, ServicePoint>, omit: Set<String> = emptySet()): Pair<Int, Int> {
        val rows = cells.filterKeys { it !in omit }.entries.toList(); val cols = 16; val pitch = 112
        val width = 2048; val height = maxOf(pitch, ((rows.size + cols - 1) / cols) * pitch).coerceAtMost(2048)
        val frames = rows.mapIndexed { index, (key, size) -> mapOf("filename" to key, "rotated" to false, "trimmed" to false,
            "frame" to mapOf("x" to index % cols * pitch, "y" to index / cols * pitch, "w" to size.x.toInt(), "h" to size.y.toInt()),
            "sourceSize" to mapOf("w" to size.x.toInt(), "h" to size.y.toInt()), "spriteSourceSize" to mapOf("x" to 0, "y" to 0, "w" to size.x.toInt(), "h" to size.y.toInt())) }
        val atlas = serviceJson(mapOf("textures" to listOf(mapOf("image" to "$id@1x.png", "format" to "RGBA8888", "scale" to 1, "size" to mapOf("w" to width, "h" to height), "frames" to frames))))
        val json = File(root, "atlas/$id@1x.json"); json.parentFile.mkdirs(); json.writeText(atlas.toJson(JsonWriter.OutputType.json))
        val header = ByteBuffer.allocate(29); header.put(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)).putInt(13).put("IHDR".toByteArray()).putInt(width).putInt(height).put(byteArrayOf(8, 6, 0, 0, 0))
        File(root, "atlas/$id@1x.png").writeBytes(header.array())
        return width to height
    }
    private fun pin(group: JsonValue, root: File, size: Pair<Int, Int>, decodedOverride: Long? = null) {
        group.get("decodedBytes").set(decodedOverride ?: (size.first.toLong() * size.second * 4), null)
        for (pin in group.get("files")) { val file = File(root, pin.getString("path")); pin.get("size").set(file.length(), null); pin.get("sha256").set(sha(file.readBytes())) }
    }
    private fun groupJson(id: String): JsonValue {
        val g = JsonValue(JsonValue.ValueType.`object`); g.addChild("id", JsonValue(id)); g.addChild("atlasPath", JsonValue("atlas/$id@1x.json")); g.addChild("imagePath", JsonValue("atlas/$id@1x.png")); g.addChild("decodedBytes", JsonValue(4L))
        val files = JsonValue(JsonValue.ValueType.array)
        for (path in listOf("atlas/$id@1x.json", "atlas/$id@1x.png")) { val p = JsonValue(JsonValue.ValueType.`object`); p.addChild("path", JsonValue(path)); p.addChild("sha256", JsonValue("0".repeat(64))); p.addChild("size", JsonValue(1L)); files.addChild(p) }
        g.addChild("files", files); return g
    }
    /** The renderer16 service art and the renderer17 private capability, both pinned to header-only files under one folder. */
    private fun fixture(omitCells: Map<String, Set<String>> = emptyMap(), fleetDecodedOverride: Map<String, Long> = emptyMap()): Fixture {
        val root = temporary.newFolder(); val sizes = linkedMapOf<String, Pair<Int, Int>>()
        val catalogue = JsonReader().parse(CosmeticsCandidateFixture.renderCatalogueText())
        val unpinned = requireNotNull(RendererCatalogue.serviceArt(catalogue))
        for ((section, id) in listOf("phaseE" to "pe_workshop_t1", "phaseE" to "pe_fleet_berths", "boundCosmetics" to "pe_cosmetics")) {
            val cells = linkedMapOf<String, ServicePoint>()
            unpinned.clips.values.forEach { clip -> clip.frames.filter { unpinned.groupFor(it.key).id == id }.forEach { cells[it.key] = clip.cell } }
            unpinned.appearances.values.forEach { a -> a.states.values.filterIsInstance<ServiceArtState.Still>().filter { unpinned.groupFor(it.key).id == id }.forEach { cells[it.key] = a.geometry.cell } }
            val size = writeAtlas(root, id, cells); sizes["$id@1x.png"] = size
            pin(catalogue.get(section).get("groups").first { it.getString("id") == id }, root, size)
        }
        val serviceArt = requireNotNull(RendererCatalogue.serviceArt(catalogue))
        // Fleet inventories straight from the authentic sidecars: starter clips pack in pe_fleet_starter, advanced clips in their `atlas`.
        val starter = sidecar("pe_fleet_starter.manifest.json", "14b400ca96c252619e251aaf2e596430179788a9371a0a6c30d58f84834fe510")
        val advanced = sidecar("pe_advanced_fleet.manifest.json", "fde4e84867e56b09bdfc10feff287ae76f01644546a061e99fd3af85a2c19299")
        val inventories = linkedMapOf<String, LinkedHashMap<String, ServicePoint>>()
        fun claim(group: String, clip: JsonValue) { val cells = inventories.getOrPut(group) { linkedMapOf() }; for (f in clip.get("frames")) cells[f.getString("key")] = ServicePoint(clip.getFloat("cellW"), clip.getFloat("cellH")) }
        for (clip in starter.get("clips")) claim("pe_fleet_starter", clip)
        for (clip in advanced.get("clips")) claim(clip.getString("atlas"), clip)
        val groups = JsonValue(JsonValue.ValueType.array)
        for (id in fleetGroupIds) {
            val size = writeAtlas(root, id, inventories.getValue(id), omitCells[id].orEmpty()); sizes["$id@1x.png"] = size
            val g = groupJson(id); pin(g, root, size, fleetDecodedOverride[id]); groups.addChild(g)
        }
        catalogue.get("rendererContractVersion").set(17L, null)
        val fleet = JsonValue(JsonValue.ValueType.`object`); fleet.addChild("version", JsonValue(1L))
        val metadata = JsonValue(JsonValue.ValueType.`object`); metadata.addChild("peStarterFleet", starter); metadata.addChild("peAdvancedFleet", advanced); fleet.addChild("metadata", metadata)
        fleet.addChild("groups", groups); catalogue.addChild("fleetJourneys", fleet)
        val pinnedText = catalogue.toJson(JsonWriter.OutputType.json)
        return Fixture(serviceArt, PhaseEFleetArt.parse(catalogue), root, sizes, pinnedText)
    }
    private val berth = RenderBuilding("berth-1", "service:berth:1", 2f, 2f, 2f, 2f, type = "berth", level = 1, service = RenderServiceIdentity("berth", null))
    private val workshop = RenderBuilding("workshop-1", "service:workshop:1", 6f, 3f, 2f, 2f, type = "workshop", level = 1, service = RenderServiceIdentity("workshop", 1))
    private val market = RenderBuilding("market-1", "service:market:1", 9f, 3f, 2f, 2f, type = "market", level = 1, service = RenderServiceIdentity("market", 1))
    /** A Market wearing the admitted tier-1 Awning: its ORDINARY plan already selects the cosmetics group. */
    private fun awning(f: Fixture) = f.serviceArt.cosmetics!!.bindings.getValue("artisan_market_awning_t1").let { RenderMarketAwning(market.id, "artisan_market_awning_t1", it.sha256, it.sourceManifestSha256, it.sourceIndexSha256) }
    private fun starterFacts(presence: RenderStarterPresence = RenderStarterPresence.OCCUPIED, enabled: Boolean? = true) =
        RenderServiceFacts(enabled, berths = listOf(RenderBerthPresentation(berth.id, RenderStarterInstallation("starter", presence))))
    private fun advancedFacts(family: String, tier: Int, presence: RenderAdvancedPresence = RenderAdvancedPresence.OCCUPIED, starterInstalled: Boolean = false) =
        RenderServiceFacts(true, berths = listOf(RenderBerthPresentation(berth.id, if (starterInstalled) RenderStarterInstallation("starter", RenderStarterPresence.OCCUPIED) else null)),
            currentAdvancedBerths = listOf(RenderAdvancedBerth(berth.id, RenderAdvancedInstallation(family, tier, presence))))
    private fun scene(facts: RenderServiceFacts, vararg buildings: RenderBuilding = arrayOf(berth)) =
        BaseScene(buildings.toList(), columns = 12, rows = 12, tilePixels = 32f, baseId = "base-1", services = facts)
    private fun prepare(f: Fixture, base: BaseScene, source: Source = Source(f.root, f.allGroups), battle: Boolean = false,
        enabled: Boolean = true, fleet: PhaseEFleetArt? = f.capability, diagnostics: MutableList<String> = mutableListOf()) =
        ServiceSceneAssets.prepare(f.serviceArt, base, source, enabled, false, battle, {}, { diagnostics += it }, f::decode, fleet)
    private fun journey(kind: RenderJourneyKind = RenderJourneyKind.DEPARTURE, family: String = "starter", tier: Int? = null, wake: RenderJourneyWake = RenderJourneyWake.Legacy) =
        RenderFleetJourney("$kind:$family:e1", kind, "base-1", berth.id, "inst-1", RenderJourneyVehicle(family, tier), wake)
    private fun resident(assets: ServiceSceneAssets) = assets.allAtlases.values.map { JourneyResidentAtlas(it.path, it.cells) }

    @Test fun `a current starter berth selects exactly its craft group, the shared gate group and the Wake group - resident at exact canonical paths`() {
        val f = fixture(); val source = Source(f.root, f.allGroups); val diagnostics = mutableListOf<String>()
        val assets = prepare(f, scene(starterFacts()), source, diagnostics = diagnostics)
        assertEquals(listOf("pe_fleet_starter", "pe_cosmetics"), source.acquired, "craft + shared gate share one group; the Wake group joins once; nothing else")
        assertEquals(emptyList(), diagnostics)
        assertEquals(setOf(berth.id), assets.plans.keys, "the selected berth keeps its entry (existing representation)"); assertTrue(assets.plans.getValue(berth.id).isEmpty(), "… with no usable ordinary plan: an OCCUPIED starter berth has no away plan")
        val fleet = assertNotNull(assets.fleet)
        assertEquals(setOf(f.canonical("pe_fleet_starter")), fleet.atlases.keys, "fleet atlases are keyed by the lease's CANONICAL path")
        assertEquals(setOf(f.canonical("pe_cosmetics")), assets.atlases.keys, "the Wake's cosmetics group is an ordinary-art atlas")
        assertEquals(setOf(f.canonical("pe_fleet_starter"), f.canonical("pe_cosmetics")), assets.paths); assertEquals(assets.allAtlases.keys, assets.paths)
        assertEquals(setOf("pe_fleet_starter", "pe_cosmetics"), fleet.groups)
        val art = assertNotNull(assets.journeyArt)
        assertEquals(f.canonical("pe_fleet_starter"), assertNotNull(art.vehicle("starter", null)).atlasPath); assertNotEquals("atlas/pe_fleet_starter@1x.json", art.vehicle("starter", null)!!.atlasPath)
        assertEquals(f.canonical("pe_fleet_starter"), assertNotNull(art.gateEffect(RenderJourneyKind.RETURN)).atlasPath)
        assertEquals(f.canonical("pe_cosmetics"), assertNotNull(art.wake(f.aurora)).atlasPath)
        assertNull(art.vehicle("survey-balloon", 1), "an unselected group resolves to NO art, never a relative identity")
        // Normal frames + separate stills + Wake cells all resolve in the prepared atlases.
        val plan = assertNotNull(selectJourneyPlan(art, berth, scene(starterFacts()).services, journey(wake = f.aurora), reducedMotion = false))
        val residency = assertNotNull(verifiedJourneyCells(plan, resident(assets)))
        assertTrue("pe_fx_departure_still_f1" in residency.effect!!); assertEquals(8, residency.wake!!.size); assertEquals(4, residency.vehicle.size)
        assertEquals(f.canonical("pe_fleet_starter").let { File(it).parentFile.resolve("pe_fleet_starter@1x.png").canonicalPath }, residency.vehicle.values.first().texture)
        assertNotNull(verifiedJourneyCells(assertNotNull(selectJourneyPlan(art, berth, scene(starterFacts()).services, journey(RenderJourneyKind.RETURN), reducedMotion = true)), resident(assets)))
        // Preparation ends ownership exactly once.
        assets.close(); assets.close(); assertEquals(source.acquired, source.released)
    }

    @Test fun `aerial advanced families acquire their craft group and the Wake group but NO tidal gate - nautical families add the shared gate group`() {
        val f = fixture()
        for ((family, tier) in listOf("survey_balloon" to 1, "courier_airship" to 4)) {
            val source = Source(f.root, f.allGroups)
            val assets = prepare(f, scene(advancedFacts(family, tier)), source)
            assertEquals(listOf("pe_veh_${family}_t$tier", "pe_cosmetics"), source.acquired, "$family t$tier")
            val art = assertNotNull(assets.journeyArt); val dash = family.replace('_', '-')
            assertEquals(f.canonical("pe_veh_${family}_t$tier"), assertNotNull(art.vehicle(dash, tier)).atlasPath)
            assertNull(art.gateEffect(RenderJourneyKind.DEPARTURE), "lift-off acquires no gate group, so gate art resolves to nothing")
            val plan = assertNotNull(selectJourneyPlan(art, berth, scene(advancedFacts(family, tier)).services, journey(family = family, tier = tier, wake = f.aurora), reducedMotion = false))
            assertNull(plan.effect); assertNotNull(verifiedJourneyCells(plan, resident(assets)))
            assets.close()
        }
        for ((family, tier) in listOf("cargo_cutter" to 2, "expedition_barge" to 3)) {
            val source = Source(f.root, f.allGroups)
            val assets = prepare(f, scene(advancedFacts(family, tier)), source)
            assertEquals(listOf("pe_veh_${family}_t$tier", "pe_fleet_starter", "pe_cosmetics"), source.acquired, "$family t$tier")
            val art = assertNotNull(assets.journeyArt)
            assertEquals(f.canonical("pe_fleet_starter"), assertNotNull(art.gateEffect(RenderJourneyKind.DEPARTURE)).atlasPath)
            val plan = assertNotNull(selectJourneyPlan(art, berth, scene(advancedFacts(family, tier)).services, journey(family = family, tier = tier), reducedMotion = false))
            assertNotNull(plan.effect); assertNotNull(verifiedJourneyCells(plan, resident(assets)))
            assertNotNull(art.vehicle("starter", null), "the leased shared group legitimately exposes the starter craft clips: group residency claims no installation")
            assertNull(selectJourneyPlan(art, berth, scene(advancedFacts(family, tier)).services, journey(), reducedMotion = false), "the typed advanced-only facts refuse a starter EVENT")
            assets.close()
        }
    }

    @Test fun `the ONE selected-pixel budget covers ordinary plus fleet plus Wake - a refused fleet addition is diagnosed, acquires nothing and leaves the ordinary scene intact`() {
        val f = fixture(fleetDecodedOverride = mapOf("pe_fleet_starter" to (MAX_SELECTED_SERVICE_RGBA_BYTES - 4)))
        val facts = RenderServiceFacts(true, berths = starterFacts().berths, activity = listOf(RenderServiceActivity(workshop.id, RenderServiceState.WORKING)))
        val source = Source(f.root, f.allGroups); val diagnostics = mutableListOf<String>()
        val assets = prepare(f, scene(facts, berth, workshop), source, diagnostics = diagnostics)
        assertEquals(listOf("pe_workshop_t1"), source.acquired, "ordinary art is prepared as before; the over-budget fleet addition acquires nothing")
        assertEquals(listOf("Fleet artwork exceeds this renderer's selected-pixel allocation limit"), diagnostics)
        assertNull(assets.fleet); assertNull(assets.journeyArt)
        assertEquals(setOf(berth.id, workshop.id), assets.plans.keys, "berth (no usable plan) plus Workshop: two entries"); assertTrue(assets.plans.getValue(workshop.id).isNotEmpty()); assertTrue(assets.plans.getValue(berth.id).isEmpty())
        assertEquals(setOf(f.canonical("pe_workshop_t1")), assets.paths)
        assets.close()
        // The same addition fits when the ordinary groups leave room.
        val fits = fixture(); val fitSource = Source(fits.root, fits.allGroups)
        prepare(fits, scene(facts, berth, workshop), fitSource).use { assertEquals(listOf("pe_workshop_t1", "pe_fleet_starter", "pe_cosmetics"), fitSource.acquired); assertNotNull(it.journeyArt) }
    }

    @Test fun `an unpinned group or a missing packed cell leaves journeys unavailable - diagnosed, never a relative identity or a partial adapter`() {
        val f = fixture(); val missing = Source(f.root, setOf("pe_cosmetics")); val diagnostics = mutableListOf<String>()
        val assets = prepare(f, scene(starterFacts()), missing, diagnostics = diagnostics)
        assertEquals(listOf("pe_fleet_starter", "pe_cosmetics"), missing.acquired); assertEquals(listOf("Fleet artwork unavailable: pe_fleet_starter"), diagnostics)
        assertNull(assets.fleet, "no fleet atlas was leased: no adapter, no journey"); assertNull(assets.journeyArt)
        assertEquals(setOf(f.canonical("pe_cosmetics")), assets.paths, "the Wake group it did lease is owned and released with the generation")
        assets.close(); assertEquals(listOf("pe_cosmetics"), missing.released)
        // The authored separate still is part of the exact expected inventory: an atlas without it is refused as a whole.
        val noStill = fixture(omitCells = mapOf("pe_fleet_starter" to setOf("pe_fx_departure_still_f1"))); val source = Source(noStill.root, noStill.allGroups); val notes = mutableListOf<String>()
        prepare(noStill, scene(starterFacts()), source, diagnostics = notes).use { assertNull(it.journeyArt); assertEquals(listOf("Fleet artwork unavailable: pe_fleet_starter"), notes) }
        assertEquals(source.acquired, source.released, "the refused atlas's lease closed at refusal, the Wake group's with the generation: every lease exactly once")
    }

    @Test fun `an admitted captured Wake whose cells are not resident must DROP the journey - the predicate the renderer's hand-off applies`() {
        val f = fixture(); val source = Source(f.root, fleetGroupIds.toSet()) // the cosmetics group is NOT pinned
        val assets = prepare(f, scene(starterFacts()), source)
        val fleet = assertNotNull(assets.fleet); val art = assertNotNull(assets.journeyArt)
        assertTrue(fleet.wakeAdmitted(f.aurora), "the capture equals the carried binding: it IS the admitted Aurora Wake")
        assertNull(art.wake(f.aurora), "but its cells are not resident in this generation")
        val plan = assertNotNull(selectJourneyPlan(art, berth, scene(starterFacts()).services, journey(wake = f.aurora), reducedMotion = false))
        assertNull(plan.wake, "the accepted consumer alone would play without the Wake: the renderer refuses this plan via wakeAdmitted")
        assertFalse(fleet.wakeAdmitted(f.aurora.copy(bindingSha256 = "f".repeat(64))), "a non-admitted capture is not a Wake: the plan plays without one as accepted")
        assertFalse(fleet.wakeAdmitted(f.aurora.copy(outputId = "artisan_market_awning_t1")))
        assets.close()
    }

    @Test fun `only a CURRENT art-permitted Home selects fleet groups - battle, missing permission, unknown or contradictory siblings, construction and level 0 select nothing`() {
        val f = fixture()
        fun acquired(base: BaseScene, battle: Boolean = false, enabled: Boolean = true): List<String> { val s = Source(f.root, f.allGroups); prepare(f, base, s, battle, enabled).close(); return s.acquired }
        assertEquals(emptyList(), acquired(scene(starterFacts()), battle = true), "frozen battle scenes never prepare journeys")
        assertEquals(emptyList(), acquired(scene(starterFacts(enabled = null))), "no art permission")
        assertEquals(emptyList(), acquired(scene(starterFacts()), enabled = false))
        assertEquals(emptyList(), acquired(scene(RenderServiceFacts(true, berths = listOf(RenderBerthPresentation(berth.id, null))))), "null installation")
        assertEquals(emptyList(), acquired(scene(RenderServiceFacts(true, berths = listOf(RenderBerthPresentation(berth.id, null)), currentAdvancedBerths = null))), "unknown advanced projection")
        assertEquals(emptyList(), acquired(scene(advancedFacts("survey_balloon", 1, starterInstalled = true))), "contradictory installed siblings")
        assertEquals(emptyList(), acquired(scene(advancedFacts("zeppelin", 1))), "unsupported family")
        assertEquals(emptyList(), acquired(scene(advancedFacts("survey_balloon", 5))), "unsupported tier")
        assertEquals(emptyList(), acquired(scene(starterFacts(), berth.copy(underConstruction = true))), "construction")
        assertEquals(emptyList(), acquired(scene(starterFacts(), berth.copy(level = 0))), "level 0")
        assertEquals(emptyList(), acquired(scene(starterFacts(), berth.copy(type = "mine", service = null))), "not a berth")
        assertEquals(emptyList(), acquired(scene(RenderServiceFacts(true, berths = List(2) { RenderBerthPresentation(berth.id, RenderStarterInstallation("starter", RenderStarterPresence.AWAY)) }))), "duplicate rows")
        // A completed Berth draws for every player; only journeys need the private fleet.
        val plain = Source(f.root, f.allGroups); prepare(f, scene(starterFacts()), plain, fleet = null).use {
            assertNull(it.fleet); assertNull(it.journeyArt); assertEquals(it.atlases, it.allAtlases)
            assertEquals("starter-berth:intact:false",it.plans.getValue(berth.id).getValue(null).signature)
        }
        assertEquals(listOf("pe_fleet_berths"), plain.acquired)
        // Presence never gates preparation. An AWAY starter berth ALSO has its ordinary away plan (pe_fleet_berths), acquired
        // first exactly as before; the fleet groups follow. EXHAUSTED advanced berths prepare like OCCUPIED ones.
        val away = Source(f.root, f.allGroups); prepare(f, scene(starterFacts(RenderStarterPresence.AWAY)), away).use { assets ->
            assertEquals(listOf("pe_fleet_berths", "pe_fleet_starter", "pe_cosmetics"), away.acquired)
            assertTrue(assets.plans.getValue(berth.id).isNotEmpty(), "the ordinary away plan is retained"); assertNotNull(assets.journeyArt)
            assertEquals(setOf(f.canonical("pe_fleet_berths"), f.canonical("pe_cosmetics")), assets.atlases.keys); assertEquals(setOf(f.canonical("pe_fleet_starter")), assets.fleet!!.atlases.keys)
        }
        assertEquals(listOf("pe_veh_cargo_cutter_t1", "pe_fleet_starter", "pe_cosmetics"), acquired(scene(advancedFacts("cargo_cutter", 1, RenderAdvancedPresence.EXHAUSTED))))
    }

    @Test fun `supersession during fleet acquisition cancels the whole preparation and releases every lease - and events never acquire`() {
        val f = fixture(); val source = Source(f.root, f.allGroups); source.failAfter = 1
        assertFailsWith<CancellationException> { prepare(f, scene(starterFacts()), source) }
        assertEquals(listOf("pe_fleet_starter", "pe_cosmetics"), source.acquired, "the second acquisition observed the stale source and cancelled")
        assertEquals(listOf("pe_fleet_starter"), source.released, "the one lease that existed is released exactly once; nothing partial is published")
        // A prepared generation is immutable: selecting and proving journeys against it performs no acquisition.
        val steady = Source(f.root, f.allGroups); val assets = prepare(f, scene(starterFacts()), steady)
        val taken = steady.acquired.toList(); val art = assertNotNull(assets.journeyArt)
        repeat(3) { val plan = assertNotNull(selectJourneyPlan(art, berth, scene(starterFacts()).services, journey(wake = f.aurora), reducedMotion = false)); assertNotNull(verifiedJourneyCells(plan, resident(assets))) }
        assertNull(selectJourneyPlan(art, berth, scene(starterFacts()).services, journey(family = "survey_balloon", tier = 1), reducedMotion = false))
        assertEquals(taken, steady.acquired, "events and lookups never load, queue or retry")
        // Each prepared generation carries its OWN adapter; arming the next one ends flights started under the previous.
        val next = prepare(f, scene(starterFacts()), Source(f.root, f.allGroups))
        assertNotSame(art, assertNotNull(next.journeyArt))
        val playback = FleetJourneyPlayback(); playback.replaceArt(art); assertTrue(playback.install(scene(starterFacts()), 1L, assets, playback.lifetime()))
        val admission = assertNotNull(playback.admission()); val plan = assertNotNull(selectJourneyPlan(art, berth, scene(starterFacts()).services, journey(), reducedMotion = false))
        assertTrue(playback.start(journey(), plan, 0L, admission, assertNotNull(verifiedJourneyCells(plan, resident(assets))))); assertTrue(playback.isActive())
        playback.revoke(); playback.replaceArt(next.journeyArt); assertFalse(playback.isActive()); assertNull(playback.admission(), "nothing can start until the next install re-admits with the new assets")
        assertFalse(playback.start(journey(), plan, 0L, admission, assertNotNull(verifiedJourneyCells(plan, resident(assets)))), "the previous admission is stale")
        assets.close(); next.close()
    }

    // ---- R1-A: leased bytes must BE the capability's pinned bytes; cosmetics identity is agreed by exact pins ----
    private fun fleetGroup(root: JsonValue, id: String) = root.get("fleetJourneys").get("groups").first { it.getString("id") == id }
    private fun flipHex(value: JsonValue) { val h = value.asString(); value.set(h.substring(1) + (if (h[0] == '0') "1" else "0")) }

    @Test fun `R1 pins - a same-id same-size fleet atlas whose JSON or PNG pin differs from the capability refuses before any canonical path is exposed, releasing its lease`() {
        val f = fixture()
        for ((name, index) in listOf("JSON" to 0, "PNG" to 1)) {
            val changed = f.variant { flipHex(fleetGroup(it, "pe_fleet_starter").get("files").get(index).get("sha256")) }
            assertEquals(f.capability.groups.getValue("pe_fleet_starter").files[index].size, changed.groups.getValue("pe_fleet_starter").files[index].size, "same size, different $name bytes claimed")
            val source = Source(f.root, f.allGroups); val notes = mutableListOf<String>()
            val assets = prepare(f, scene(starterFacts()), source, fleet = changed, diagnostics = notes)
            assertEquals(listOf("pe_fleet_starter", "pe_cosmetics"), source.acquired); assertEquals(listOf("Fleet artwork unavailable: pe_fleet_starter"), notes, "$name pin")
            assertNull(assets.fleet, "no adapter may claim bytes the capability did not pin ($name)"); assertNull(assets.journeyArt)
            assertEquals(listOf("pe_fleet_starter"), source.released, "the refused lease closed at refusal ($name)")
            assets.close(); assertEquals(listOf("pe_fleet_starter", "pe_cosmetics"), source.released)
        }
        // The pins themselves describe the synthetic header-only bytes written for this fixture (no real pixels are claimed).
        val group = f.capability.groups.getValue("pe_fleet_starter")
        assertEquals(group.files[1].sha256, sha(File(f.root, "atlas/pe_fleet_starter@1x.png").readBytes())); assertEquals(29L, group.files[1].size)
        assertFails("the binding seam refuses a changed byte directly") { verifyPackedPins(group.copy(files = listOf(group.files[0], group.files[1].copy(sha256 = "0".repeat(64)))), FileHandle(f.root)) }
        assertFails("…and a changed size") { verifyPackedPins(group.copy(files = listOf(group.files[0].copy(size = group.files[0].size + 1), group.files[1])), FileHandle(f.root)) }
        verifyPackedPins(group, FileHandle(f.root))
    }

    @Test fun `R1 cosmetics identity - a capability whose cosmetics descriptor or Aurora binding differs from the admitted service art is not its companion - fleet refuses, ordinary (including an already-leased cosmetics group) is untouched`() {
        val f = fixture()
        val otherPins = f.variant { flipHex(it.get("boundCosmetics").get("groups").get(0).get("files").get(0).get("sha256")) }
        val otherWake = f.variant { flipHex(it.get("boundCosmetics").get("metadata").get("peCosmetics").get("bindings").get("aurora_wake").get("sha256")) }
        assertFalse(ServiceSceneAssets.fleetCompatible(otherPins, f.serviceArt)); assertFalse(ServiceSceneAssets.fleetCompatible(otherWake, f.serviceArt)); assertTrue(ServiceSceneAssets.fleetCompatible(f.capability, f.serviceArt))
        for (incompatible in listOf(otherPins, otherWake)) {
            // Starter berth only: nothing fleet is selected or acquired; the refusal is diagnosed.
            val source = Source(f.root, f.allGroups); val notes = mutableListOf<String>()
            prepare(f, scene(starterFacts()), source, fleet = incompatible, diagnostics = notes).use { assertNull(it.fleet); assertNull(it.journeyArt); assertTrue(it.paths.isEmpty()) }
            assertEquals(emptyList(), source.acquired); assertEquals(listOf("Fleet artwork is not the companion of the admitted service art"), notes)
            // A Market wearing the admitted Awning ALREADY leases the cosmetics group ordinarily: that stays exactly as before,
            // and the incompatible capability borrows nothing from it by group id.
            val facts = RenderServiceFacts(true, berths = starterFacts().berths, awnings = listOf(awning(f)))
            val ordinary = Source(f.root, f.allGroups); val ordinaryNotes = mutableListOf<String>()
            prepare(f, scene(facts, berth, market), ordinary, fleet = incompatible, diagnostics = ordinaryNotes).use { assets ->
                assertEquals(listOf("pe_cosmetics"), ordinary.acquired); assertEquals(setOf(f.canonical("pe_cosmetics")), assets.atlases.keys)
                assertTrue(assets.plans.getValue(market.id).isNotEmpty(), "the Awning plan is retained"); assertNull(assets.fleet); assertNull(assets.journeyArt)
                assertEquals(listOf("Fleet artwork is not the companion of the admitted service art"), ordinaryNotes)
            }
            assertEquals(ordinary.acquired, ordinary.released)
        }
        // The companion capability with the same Market: the ordinarily leased cosmetics group is used ONCE for both.
        val both = Source(f.root, f.allGroups); val facts = RenderServiceFacts(true, berths = starterFacts().berths, awnings = listOf(awning(f)))
        prepare(f, scene(facts, berth, market), both).use { assets ->
            assertEquals(listOf("pe_cosmetics", "pe_fleet_starter"), both.acquired, "cosmetics leased once by the ordinary plan; fleet adds only the craft/gate group")
            assertEquals(f.canonical("pe_cosmetics"), assertNotNull(assets.journeyArt).wake(f.aurora)!!.atlasPath)
        }
    }

    // ---- R1-C: the ONE eligibility predicate, from actual inputs ----
    @Test fun `R1 eligibility - only the installed admission of the CURRENT requested generation, exact current source and capability, its own prepared assets and art, a current source and the base is eligible`() {
        val f = fixture(); val source = Source(f.root, f.allGroups)
        val assets = prepare(f, scene(starterFacts()), source); val art = assertNotNull(assets.journeyArt)
        val admission = JourneyAdmission(scene(starterFacts()), 7L, assets, art, 1L)
        assertSame(admission, eligibleJourneyAdmission(admission, 7L, source, f.capability, "base-1", enabled = true))
        assertNull(eligibleJourneyAdmission(admission, 8L, source, f.capability, "base-1", true), "a pending NEW generation is not eligible until it is installed")
        assertNull(eligibleJourneyAdmission(admission, 7L, Source(f.root, f.allGroups), f.capability, "base-1", true), "another source object, even an equal one")
        assertNull(eligibleJourneyAdmission(admission, 7L, source, f.variant {}, "base-1", true), "a replaced capability, even an equal one")
        assertNull(eligibleJourneyAdmission(admission, 7L, null, f.capability, "base-1", true)); assertNull(eligibleJourneyAdmission(admission, 7L, source, null, "base-1", true))
        assertNull(eligibleJourneyAdmission(admission, 7L, source, f.capability, "base-2", true)); assertNull(eligibleJourneyAdmission(admission, 7L, source, f.capability, "base-1", enabled = false))
        assertNull(eligibleJourneyAdmission(null, 7L, source, f.capability, "base-1", true))
        source.current = false; assertNull(eligibleJourneyAdmission(admission, 7L, source, f.capability, "base-1", true), "an invalid source is not eligible even with everything else current"); source.current = true
        assertSame(admission, eligibleJourneyAdmission(admission, 7L, source, f.capability, "base-1", true))
        // The admission's art must be the assets' own adapter; assets without fleet residency admit nothing.
        val other = prepare(f, scene(starterFacts()), Source(f.root, f.allGroups))
        assertNull(eligibleJourneyAdmission(JourneyAdmission(scene(starterFacts()), 7L, assets, other.journeyArt, 1L), 7L, source, f.capability, "base-1", true), "art of another generation")
        assertNull(eligibleJourneyAdmission(JourneyAdmission(scene(starterFacts()), 7L, prepare(f, scene(starterFacts()), source, fleet = null), null, 1L), 7L, source, f.capability, "base-1", true), "no fleet residency")
        // R2: the SAME predicate re-read inside the insertion gate from actual inputs — a source that stopped being current or a
        // replacement request between the proof and the insertion refuses; the positive current control admits.
        val playback = FleetJourneyPlayback(); val ticket = assertNotNull(playback.arm(art, playback.lifetime())); assertTrue(playback.install(scene(starterFacts()), 7L, assets, ticket))
        val installed = assertNotNull(playback.admission()); val plan = assertNotNull(selectJourneyPlan(art, berth, scene(starterFacts()).services, journey(), reducedMotion = false))
        val residency = assertNotNull(verifiedJourneyCells(plan, resident(assets))); var requested = 7L
        val live = { eligibleJourneyAdmission(playback.admission(), requested, source, f.capability, "base-1", true) === installed }
        source.current = false; assertFalse(playback.start(journey(), plan, 0L, installed, residency, live)); source.current = true
        requested = 8L; assertFalse(playback.start(journey(), plan, 0L, installed, residency, live)); requested = 7L
        assertFalse(playback.isActive()); assertTrue(playback.start(journey(), plan, 0L, installed, residency, live)); assertTrue(playback.isActive(berth.id))
        assets.close(); other.close()
    }

    private fun continuityScene() = scene(starterFacts().copy(currentFleetIdentity =
        listOf(RenderFleetInstallationIdentity(berth.id, "inst-1", "starter", null))))

    private fun startContinuity(base: BaseScene, assets: ServiceSceneAssets, wake: RenderJourneyWake): Pair<FleetJourneyPlayback, JourneyPlan> {
        val playback = FleetJourneyPlayback(); val art = assertNotNull(assets.journeyArt)
        assertTrue(playback.install(base, 1L, assets, assertNotNull(playback.arm(art, playback.lifetime()))))
        val flight = journey(wake = wake)
        val plan = assertNotNull(selectJourneyPlan(art, berth, base.services, flight, reducedMotion = false))
        assertTrue(playback.start(flight, plan, 1_000L, assertNotNull(playback.admission()), assertNotNull(verifiedJourneyCells(plan, resident(assets)))))
        return playback to plan
    }

    @Test fun `continuity uses real prepared adapters through two pending requests`() {
        val f = fixture(); val source = Source(f.root, f.allGroups); val base = continuityScene()
        prepare(f, base, source).use { old -> prepare(f, base, source).use { fresh ->
            assertNotSame(old.journeyArt, fresh.journeyArt, "normal preparations create distinct adapters")
            val (playback, plan) = startContinuity(base, old, f.aurora)
            val expected = mutableListOf<JourneySprite>(); assertTrue(playback.sprites(berth, 1_500L, 0f, 32f, expected))
            val generation = java.util.concurrent.atomic.AtomicLong(1L)
            val first = playback.authorizeRequest({ generation.incrementAndGet() }) { j, b -> journeyContinuity(base, j, b) }
            val second = playback.authorizeRequest({ generation.incrementAndGet() }) { j, b -> journeyContinuity(base, j, b) }
            assertEquals(3L, second.first); assertNull(playback.admission(), "pending continuity never admits a new event")
            assertNull(playback.arm(fresh.journeyArt, first.second), "superseded preparation arms late after the successor request")
            assertTrue(playback.isActive(), "the stale arm leaves the newer original intact")
            assertTrue(playback.continuityDrawable(berth, old, source, f.capability, second.first, true))
            assertFalse(playback.continuityDrawable(berth, old, source, f.capability, first.first, true), "proof is bound to the latest request")
            assertFalse(playback.continuityDrawable(berth, fresh, source, f.capability, second.first, true), "pending draw owns the old active leases")
            assertFalse(playback.continuityDrawable(berth, old, Source(f.root, f.allGroups), f.capability, second.first, true))
            assertFalse(playback.continuityDrawable(berth, old, source, f.variant {}, second.first, true))
            assertFalse(playback.continuityDrawable(berth, old, source, f.capability, second.first, false), "permission/lifecycle/mode gate")
            source.current = false
            assertFalse(playback.continuityDrawable(berth, old, source, f.capability, second.first, true))
            source.current = true
            val pending = mutableListOf<JourneySprite>(); assertTrue(playback.sprites(berth, 1_500L, 0f, 32f, pending)); assertEquals(expected, pending)
            val ticket = assertNotNull(playback.arm(fresh.journeyArt, second.second))
            assertTrue(playback.continuityDrawable(berth, old, source, f.capability, second.first, true), "arming retains the original until the fresh install")
            assertTrue(playback.install(base, second.first, fresh, ticket))
            assertFalse(playback.continuityDrawable(berth, old, source, f.capability, second.first, true), "the pending branch ends on install")
            val rebound = mutableListOf<JourneySprite>(); assertTrue(playback.sprites(berth, 1_500L, 0f, 32f, rebound)); assertEquals(expected, rebound)
            val newCells = resident(fresh).flatMap { it.cells.values }
            assertTrue(rebound.all { sprite -> newCells.any { it === sprite.cell } }, "all cells now belong to the fresh generation")
            val end = 1_000L + plan.durationMs.toLong()
            assertTrue(playback.sprites(berth, end - 1L, 0f, 32f, mutableListOf()))
            assertFalse(playback.sprites(berth, end + 1L, 0f, 32f, mutableListOf()), "the original age was not restarted")
        } }
        assertEquals(source.acquired.sorted(), source.released.sorted())
    }

    @Test fun `continuity rejects changed ownership and missing original cells`() {
        val f = fixture(); val source = Source(f.root, f.allGroups); val base = continuityScene()
        for (failure in listOf("source", "capability", "craft", "effect", "wake", "wake binding")) {
            prepare(f, base, source).use { old ->
                val nextSource = if (failure == "source") Source(f.root, f.allGroups) else source
                val nextCapability = if (failure == "capability") f.variant {} else f.capability
                prepare(f, base, nextSource, fleet = nextCapability).use { fresh ->
                    val (playback, plan) = startContinuity(base, old, f.aurora)
                    val (token, predecessor) = playback.authorizeRequest({ 2L }) { j, b -> journeyContinuity(base, j, b) }
                    val missingKey = when (failure) {
                        "craft" -> plan.vehicle.frames.first()
                        "effect" -> assertNotNull(plan.effect).frames.first()
                        "wake" -> assertNotNull(plan.wake).frames.first()
                        else -> null
                    }
                    val cells = resident(fresh).map { atlas -> atlas.copy(cells = atlas.cells.filterKeys { it != missingKey }) }
                    if (failure == "wake binding") {
                        // An original bound to different Wake pins cannot borrow the otherwise present cosmetics cells.
                        playback.revoke()
                        assertTrue(playback.install(base, 1L, old, assertNotNull(playback.arm(old.journeyArt, playback.lifetime()))))
                        val mismatched = journey(wake = f.aurora.copy(bindingSha256 = "0".repeat(64)))
                        assertTrue(playback.start(mismatched, plan, 1_000L, assertNotNull(playback.admission()), assertNotNull(verifiedJourneyCells(plan, resident(old)))))
                        val request = playback.authorizeRequest({ 2L }) { j, b -> journeyContinuity(base, j, b) }
                        assertTrue(playback.install(base, request.first, fresh, assertNotNull(playback.arm(fresh.journeyArt, request.second)), cells))
                    } else {
                        assertTrue(playback.install(base, token, fresh, assertNotNull(playback.arm(fresh.journeyArt, predecessor)), cells))
                    }
                    assertFalse(playback.isActive(), failure)
                    assertFalse(playback.sprites(berth, 1_500L, 0f, 32f, mutableListOf()), "whole original drops: $failure")
                }
            }
        }
        assertEquals(source.acquired.sorted(), source.released.sorted())
    }

    @Test fun `current preparation failure revokes before and after arm`() {
        val f = fixture(); val source = Source(f.root, f.allGroups); val base = continuityScene()
        for (armed in listOf(false, true)) prepare(f, base, source).use { old -> prepare(f, base, source).use { fresh ->
            val (playback, _) = startContinuity(base, old, f.aurora)
            val generation = java.util.concurrent.atomic.AtomicLong(1L)
            val (token, predecessor) = playback.authorizeRequest({ generation.incrementAndGet() }) { j, b -> journeyContinuity(base, j, b) }
            val ticket = if (armed) assertNotNull(playback.arm(fresh.journeyArt, predecessor)) else predecessor
            assertTrue(playback.failPreparation { assertTrue(Thread.holdsLock(playback)); generation.get() == token })
            assertFalse(playback.isActive()); assertNull(playback.admission())
            assertFalse(playback.continuityDrawable(berth, old, source, f.capability, token, true))
            assertFalse(playback.install(base, token, fresh, ticket), "a failed ticket cannot install or revive")
            assertNull(playback.arm(fresh.journeyArt, predecessor), "late arming is also stale")
        } }
        assertEquals(source.acquired.sorted(), source.released.sorted())
    }

    @Test fun `stale failure preserves successor and incompatible request cancels`() {
        val f = fixture(); val source = Source(f.root, f.allGroups); val base = continuityScene()
        prepare(f, base, source).use { old -> prepare(f, base, source).use { fresh ->
            val (playback, _) = startContinuity(base, old, f.aurora)
            val generation = java.util.concurrent.atomic.AtomicLong(1L)
            val first = playback.authorizeRequest({ generation.incrementAndGet() }) { j, b -> journeyContinuity(base, j, b) }
            val next = playback.authorizeRequest({ generation.incrementAndGet() }) { j, b -> journeyContinuity(base, j, b) }
            assertFalse(playback.failPreparation { assertTrue(Thread.holdsLock(playback)); generation.get() == first.first })
            assertTrue(playback.continuityDrawable(berth, old, source, f.capability, next.first, true))
            assertTrue(playback.install(base, next.first, fresh, assertNotNull(playback.arm(fresh.journeyArt, next.second))))
            assertTrue(playback.isActive())
            val changed = base.copy(services = base.services.copy(currentFleetIdentity = listOf(RenderFleetInstallationIdentity(berth.id, "replacement", "starter", null))))
            playback.authorizeRequest({ generation.incrementAndGet() }) { j, b -> journeyContinuity(changed, j, b) }
            assertFalse(playback.isActive()); assertNull(playback.admission())
        } }
        assertEquals(source.acquired.sorted(), source.released.sorted())
    }

    @Test fun `stale armed install cannot erase a newer running original`() {
        val f = fixture(); val source = Source(f.root, f.allGroups); val base = continuityScene()
        prepare(f, base, source).use { old -> prepare(f, base, source).use { firstAssets -> prepare(f, base, source).use { latestAssets ->
            val (playback, plan) = startContinuity(base, old, f.aurora)
            val expected = mutableListOf<JourneySprite>(); assertTrue(playback.sprites(berth, 1_500L, 0f, 32f, expected))
            val generation = java.util.concurrent.atomic.AtomicLong(1L)
            val first = playback.authorizeRequest({ generation.incrementAndGet() }) { j, berth -> journeyContinuity(base, j, berth) }
            val firstTicket = assertNotNull(playback.arm(firstAssets.journeyArt, first.second))
            // Main's successor request lands after GL checked generation but before the earlier install takes the monitor.
            val latest = playback.authorizeRequest({ generation.incrementAndGet() }) { j, berth -> journeyContinuity(base, j, berth) }
            assertFalse(playback.install(base, first.first, firstAssets, firstTicket))
            assertNull(playback.admission()); assertTrue(playback.isActive())
            assertTrue(playback.continuityDrawable(berth, old, source, f.capability, latest.first, true))
            assertTrue(playback.install(base, latest.first, latestAssets, assertNotNull(playback.arm(latestAssets.journeyArt, latest.second))))
            val actual = mutableListOf<JourneySprite>(); assertTrue(playback.sprites(berth, 1_500L, 0f, 32f, actual)); assertEquals(expected, actual)
            assertFalse(playback.sprites(berth, 1_001L + plan.durationMs.toLong(), 0f, 32f, mutableListOf()), "superseded install never resets age")
        } } }
        assertEquals(source.acquired.sorted(), source.released.sorted())
    }
    @Test fun `stale GL failure leaves successor ownership and predecessor valid`() {
        val f = fixture(); val source = Source(f.root, f.allGroups); val base = continuityScene()
        prepare(f, base, source).use { old -> prepare(f, base, source).use { firstAssets -> prepare(f, base, source).use { latestAssets ->
            val (playback, _) = startContinuity(base, old, f.aurora)
            val generation = java.util.concurrent.atomic.AtomicLong(1L)
            val first = playback.authorizeRequest({ generation.incrementAndGet() }) { j, b -> journeyContinuity(base, j, b) }
            assertNotNull(playback.arm(firstAssets.journeyArt, first.second))
            val latest = playback.authorizeRequest({ generation.incrementAndGet() }) { j, b -> journeyContinuity(base, j, b) }
            // Actual optional-upload drop seam: A can discard its own staged resources,
            // but its late failure cannot invalidate B's preserved original or arming authority.
            assertFalse(playback.revokeDelivery(first.first) { assertTrue(Thread.holdsLock(playback)); generation.get() })
            assertTrue(playback.continuityDrawable(berth, old, source, f.capability, latest.first, true))
            assertTrue(playback.install(base, latest.first, latestAssets, assertNotNull(playback.arm(latestAssets.journeyArt, latest.second))))
            assertTrue(playback.isActive())
            assertTrue(playback.revokeDelivery(latest.first) { generation.get() }, "a current GL failure still cancels promptly")
            assertFalse(playback.isActive()); assertNull(playback.admission())
        } } }
        assertEquals(source.acquired.sorted(), source.released.sorted())
    }

    @Test fun `GL commit preserves active assets across superseded delivery`() {
        val f = fixture(); val source = Source(f.root, f.allGroups); val base = continuityScene()
        prepare(f, base, source).use { old -> prepare(f, base, source).use { firstAssets -> prepare(f, base, source).use { latestAssets ->
            val (playback, plan) = startContinuity(base, old, f.aurora)
            val expected = mutableListOf<JourneySprite>(); assertTrue(playback.sprites(berth, 1_500L, 0f, 32f, expected))
            val generation = java.util.concurrent.atomic.AtomicLong(1L)
            var activeAssets = old; var sceneToken = 1L; var frameOwner = old
            val retired = mutableListOf<ServiceSceneAssets>()
            val first = playback.authorizeRequest({ generation.incrementAndGet() }) { j, b -> journeyContinuity(base, j, b) }
            val firstTicket = assertNotNull(playback.arm(firstAssets.journeyArt, first.second))
            assertEquals(first.first, generation.get()) // GL's former unlocked pre-check passed.
            val latest = playback.authorizeRequest({ generation.incrementAndGet() }) { j, b -> journeyContinuity(base, j, b) }
            val committed = playback.commitDelivery({ assertTrue(Thread.holdsLock(playback)); first.first == generation.get() }) {
                activeAssets = firstAssets; sceneToken = first.first; frameOwner = firstAssets
                playback.install(base, first.first, firstAssets, firstTicket)
            }
            if (committed) retired += old // renderer retirement is reachable only after this commit.
            assertFalse(committed); assertSame(old, activeAssets); assertSame(old, frameOwner)
            assertEquals(1L, sceneToken); assertTrue(retired.isEmpty())
            assertTrue(playback.continuityDrawable(berth, activeAssets, source, f.capability, latest.first, true))
            var staleNullTicketBranch = false
            assertFalse(playback.commitDelivery({ first.first == generation.get() }) {
                staleNullTicketBranch = true; playback.revokeDelivery(first.first) { generation.get() }
            })
            assertFalse(staleNullTicketBranch, "superseded battle/null-ticket activation cannot mutate or revoke")
            val latestTicket = assertNotNull(playback.arm(latestAssets.journeyArt, latest.second))
            assertTrue(playback.commitDelivery({ latest.first == generation.get() }) {
                activeAssets = latestAssets; sceneToken = latest.first; frameOwner = latestAssets
                assertTrue(playback.install(base, latest.first, activeAssets, latestTicket))
            })
            retired += old
            assertSame(latestAssets, activeAssets); assertEquals(listOf(old), retired)
            val actual = mutableListOf<JourneySprite>(); assertTrue(playback.sprites(berth, 1_500L, 0f, 32f, actual)); assertEquals(expected, actual)
            assertFalse(playback.sprites(berth, 1_001L + plan.durationMs.toLong(), 0f, 32f, mutableListOf()), "ownership commit never resets original age")
        } } }
        assertEquals(source.acquired.sorted(), source.released.sorted())
    }

}
