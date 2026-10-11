package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.renderer.*
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Historical renderer17 entry admission from pinned /iw3 metadata plus wire-propagation fixtures.
 * Metadata/scene preparation only: these tests do not claim installed service pixels. */
class ServiceSceneMapperTest {
    private fun json(path: String) = Json.parseToJsonElement(File(path).readText()).jsonObject
    private fun pinnedMetadata(name: String, size: Int, sha256: String): JsonObject {
        val bytes = requireNotNull(ServiceSceneMapperTest::class.java.getResourceAsStream("/iw3/$name")).use { it.readBytes() }
        assertEquals("$name byte count", size, bytes.size)
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
        assertEquals("$name must be the unchanged Build1R tracked fixture", sha256, digest)
        return Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
    }
    private val catalogue = pinnedMetadata("catalogue.json", 305562, "a844d2ee5322bc687eaaea2874eb87a7df9ef2b1775171397750dce56685a5a2")
    private val installedRender = pinnedMetadata("render-catalog.json", 8032245, "f9eff00c5a8119e3aed0675d816ba5371d1634332f36a398b570c1c488988133").also { installed ->
        RendererCatalogue.validate(installed.toString())
        // The historical Build1R fixture remains renderer17 regardless of the currently bundled pack.
        assertEquals(17,installed.getValue("rendererContractVersion").jsonPrimitive.int)
    }
    private val render = installedRender.let { installed ->
        // Owned historical view for the original wire-only tests; remove newer optional
        // graphs as well as service entries so the renderer14 fixture remains truthful.
        // The real installedRender above and its entry regression below stay untouched.
        val legacyEntries=installed.getValue("entries").jsonArray.filter { row ->
            if(row.jsonObject.containsKey("phaseE")) {
                PhaseEServiceArt.entry(com.badlogic.gdx.utils.JsonReader().parse(row.toString()));false
            } else true
        }
        JsonObject(installed - "phaseE" - "boundCosmetics" - "fleetJourneys" + buildJsonObject {
            put("rendererContractVersion",14);put("entries",JsonArray(legacyEntries))
        }).also { RendererCatalogue.validate(it.toString()) }
    }
    private val legacy = json("src/debug/assets/native/fixtures/base.json")
    private val types = listOf("workshop", "market", "lodge", "harvester", "berth")
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12,'0')}"
    private val template = render.getValue("entries").jsonArray.first().jsonObject
    private val fixtureRender = JsonObject(render + ("entries" to JsonArray(render.getValue("entries").jsonArray + types.map { type ->
        JsonObject(template + buildJsonObject { put("type", type); put("level", 1) })
    })))
    private val mapper = SceneMapper(catalogue, fixtureRender)
    private fun presentation(presence: String? = "away") = buildJsonObject {
        put("version", 1); put("berths", buildJsonArray { add(buildJsonObject {
            put("buildingId", id(5)); put("installation", presence?.let { buildJsonObject {
                put("family", "starter"); put("presence", it)
            } } ?: JsonNull)
        }) })
    }
    private fun home(enabled: Boolean = true) = JsonObject(legacy + buildJsonObject {
        put("baseId", id(9)); put("jobs", buildJsonArray {})
        put("buildings", buildJsonArray { types.forEachIndexed { index, type -> add(buildJsonObject {
            put("id", id(index + 1)); put("type", type); put("level", 1); put("tx", index + 3); put("ty", 4)
        }) } })
        put("features", buildJsonObject {
            put("phaseEArt", buildJsonObject { put("version", 1); put("enabled", enabled) })
            put("phaseEBuildings", buildJsonObject { put("version", 1); put("enabledTypes", buildJsonArray {}) })
        })
        put("servicePresentation", presentation())
        put("serviceActivity", buildJsonObject {
            put("version", 1); put("services", buildJsonArray {
                listOf("ready", "idle", "working", "working").forEachIndexed { index, state -> add(buildJsonObject {
                    put("buildingId", id(index + 1)); put("state", state)
                }) }
            })
        })
    })
    private fun envelope(snapshot: JsonObject = home(), facts: JsonElement? = presentation("occupied")) = buildJsonObject {
        put("stage", 1); put("raidId", "frozen-service-raid"); put("id", "frozen-service-raid"); put("revision", "original")
        put("simVersion", catalogue.getValue("simVersion")); put("lastSequence", 0); put("events", buildJsonArray {})
        put("snapshot", snapshot)
        if (facts != null) put("servicePresentation", facts)
        // Even hostile current fields at either level are not historical authority.
        put("features", home().getValue("features")); put("serviceActivity", home().getValue("serviceActivity"))
    }

    @Test fun `real bundled renderer17 maps the four seeded fixture facilities without a static fallback`() {
        // Source layout: fleet-journey-browser.ts facility calls. IDs are synthetic;
        // the render entries and all geometry/tier constants are the actual bundle.
        val placed = listOf(Triple("workshop", 9, 10), Triple("market", 19, 10),
            Triple("lodge", 9, 18), Triple("berth", 17, 18))
        val raw = JsonObject(home(false) + ("buildings" to buildJsonArray {
            placed.forEach { (type, x, y) -> add(buildJsonObject {
                put("id", id(types.indexOf(type) + 1)); put("type", type)
                put("level", 1); put("tx", x); put("ty", y)
            }) }
        }))
        val entries = installedRender.getValue("entries").jsonArray.map { it.jsonObject }
        val expectedIdentities = placed.map { (type, _, _) ->
            val entry = entries.single { it["type"] == JsonPrimitive(type) && it["level"] == JsonPrimitive(1) }
            assertTrue(entry.containsKey("phaseE")); assertFalse(entry.containsKey("frameKey"))
            PhaseEServiceArt.entry(com.badlogic.gdx.utils.JsonReader().parse(entry.toString()))
        }
        assertEquals(listOf("workshop", "market", "lodge", "berth"), expectedIdentities.map { it.facility })
        assertEquals(listOf(1, 1, 1, null), expectedIdentities.map { it.tier })
        val scene = SceneMapper(catalogue, installedRender).baseScene(raw)
        assertEquals(4, scene.buildings.size)
        assertEquals(expectedIdentities, scene.buildings.map { it.service })
        assertEquals(placed.map { it.first }, scene.buildings.map { it.type })
        assertEquals(placed.map { it.second.toFloat() to it.third.toFloat() },
            scene.buildings.map { it.tileX to it.tileY })
        assertTrue(scene.buildings.all { it.frameKey == "service:${it.type}:1" })
        assertTrue(scene.buildings.all { it.footprintWidth == 2f && it.footprintHeight == 2f })
        assertEquals("Renderer admission cannot grant the paused server art permission", false,
            scene.services.phaseEArtEnabled)
    }

    @Test fun `service mapper retains exact renderer15 and renderer16 support alongside renderer17`() {
        for (version in listOf(15, 16, 17)) {
            val scene = SceneMapper(serviceCatalogue, serviceEntryCatalogue(version)).baseScene(home(false))
            assertEquals(types, scene.buildings.map { it.service!!.facility })
            assertEquals(listOf(1, 1, 1, 1, null), scene.buildings.map { it.service!!.tier })
            assertEquals(false, scene.services.phaseEArtEnabled)
        }
    }

    @Test fun `service mapper refuses older future missing and malformed renderer versions`() {
        val candidate = serviceEntryCatalogue(17)
        val unsupported = listOf(JsonPrimitive(14), JsonPrimitive(18), JsonPrimitive(999),
            JsonPrimitive("17"), JsonPrimitive(17.5), JsonPrimitive(true), JsonNull)
        for (version in unsupported) {
            assertThrows(IllegalArgumentException::class.java) {
                SceneMapper(serviceCatalogue, JsonObject(candidate + ("rendererContractVersion" to version))).baseScene(home())
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            SceneMapper(serviceCatalogue, JsonObject(candidate - "rendererContractVersion")).baseScene(home())
        }
    }

    @Test fun `renderer17 still refuses invented static fallback and malformed service marker`() {
        for (replacement in listOf(
            buildJsonObject { put("frameKey", "invented-fallback") },
            buildJsonObject { put("phaseE", buildJsonObject { put("facility", "workshop"); put("tier", "1") }) }
        )) {
            val candidate = serviceEntryCatalogue(17)
            val rows = candidate.getValue("entries").jsonArray.map { row ->
                if (row.jsonObject["type"] == JsonPrimitive("workshop")) JsonObject(row.jsonObject + replacement) else row
            }
            assertThrows(IllegalArgumentException::class.java) {
                SceneMapper(serviceCatalogue, JsonObject(candidate + ("entries" to JsonArray(rows)))).baseScene(home())
            }
        }
    }

    @Test fun `legacy contract14 scene remains unchanged with unknown additive service facts`() {
        val old = SceneMapper(catalogue, render).baseScene(legacy)
        assertEquals(RenderServiceFacts(), old.services)
        assertEquals(14, render.getValue("rendererContractVersion").jsonPrimitive.int)
        assertEquals(old.buildings, mapper.baseScene(legacy).buildings)
        assertEquals(old.jobs, mapper.baseScene(legacy).jobs)
    }
    @Test fun `current exact server states survive a paused construction gate without changing any sprite`() {
        val enabled = mapper.baseScene(home())
        val disabled = mapper.baseScene(home(false))
        assertEquals(true, enabled.services.phaseEArtEnabled); assertEquals(false, disabled.services.phaseEArtEnabled)
        assertEquals(listOf(RenderServiceState.READY, RenderServiceState.IDLE, RenderServiceState.WORKING, RenderServiceState.WORKING),
            enabled.services.activity!!.map { it.state })
        assertEquals(RenderStarterPresence.AWAY, enabled.services.berths!!.single().installation!!.presence)
        assertEquals(enabled.services.activity, disabled.services.activity)
        assertEquals(enabled.services.berths, disabled.services.berths)
        assertEquals(enabled.buildings, disabled.buildings)
        assertEquals(setOf(template.getValue("frameKey").jsonPrimitive.content), enabled.buildings.map { it.frameKey }.toSet())
    }
    @Test fun `malformed new optional facts clear prior positives independently without failing scene preparation`() {
        val before = mapper.baseScene(home())
        assertEquals(true, before.services.phaseEArtEnabled)
        val changed = JsonObject(home() + buildJsonObject {
            put("features", buildJsonObject { put("phaseEArt", buildJsonObject { put("version", 2); put("enabled", true) }) })
            put("serviceActivity", JsonObject(home().getValue("serviceActivity").jsonObject + ("wallet" to JsonPrimitive("private"))))
        })
        val next = mapper.baseScene(changed)
        assertNull(next.services.phaseEArtEnabled); assertNull(next.services.activity)
        assertEquals(before.services.berths, next.services.berths)
        assertEquals(before.buildings, next.buildings)
    }
    @Test fun `another base or changed building set cannot reuse previous service observations`() {
        val changed = JsonObject(home() + buildJsonObject {
            put("baseId", id(10)); put("buildings", buildJsonArray { types.forEachIndexed { index, type -> add(buildJsonObject {
                put("id", id(index + 11)); put("type", type); put("level", 1); put("tx", index + 3); put("ty", 4)
            }) } })
        })
        val next = mapper.baseScene(changed)
        assertNull(next.services.berths); assertNull(next.services.activity)
        assertEquals(id(10), next.baseId)
    }
    @Test fun `preview and live battle use only envelope frozen berth facts and never current activity or permission`() {
        val source = envelope()
        val scenes = listOf(mapper.previewScene(source, catalogue.getValue("simVersion").jsonPrimitive.int), mapper.liveScene(source))
        for (scene in scenes) {
            assertEquals(RenderStarterPresence.OCCUPIED, scene.base.services.berths!!.single().installation!!.presence)
            assertNull(scene.base.services.activity); assertNull(scene.base.services.phaseEArtEnabled)
        }
        val absent = mapper.liveScene(envelope(facts = null))
        assertNull("Inner snapshot's current berth facts cannot repair absent history", absent.base.services.berths)
        val invalid = mapper.liveScene(envelope(facts = JsonObject(presentation() + ("version" to JsonPrimitive(2)))))
        assertNull(invalid.base.services.berths)
    }
    @Test fun `scout is frozen despite directly carrying a current-shaped base and an empty berth stays distinct from unknown`() {
        val source = JsonObject(home() + ("servicePresentation" to presentation(null)))
        val scene = mapper.scoutScene(source, "defender", catalogue.getValue("simVersion").jsonPrimitive.int)
        assertNotNull(scene.base.services.berths)
        assertNull(scene.base.services.berths!!.single().installation)
        assertNull(scene.base.services.activity); assertNull(scene.base.services.phaseEArtEnabled)
    }
    @Test fun `archive retains original berth presence and never reconstructs missing history from inner snapshot`() {
        val recorded = json("src/debug/assets/native/fixtures/replay.json")
        val source = JsonObject(recorded + envelope() + ("events" to recorded.getValue("events")))
        val replay = mapper.replayScene(source)
        assertEquals(RenderStarterPresence.OCCUPIED, replay.base.services.berths!!.single().installation!!.presence)
        assertNull(replay.base.services.activity); assertNull(replay.base.services.phaseEArtEnabled)
        assertNull(mapper.replayScene(JsonObject(source - "servicePresentation")).base.services.berths)
    }
    @Test fun `scene service lists are owned and cannot mutate a prepared generation`() {
        val scene = mapper.baseScene(home())
        assertTrue(runCatching { (scene.services.berths as MutableList).clear() }.isFailure)
        assertTrue(runCatching { (scene.services.activity as MutableList).clear() }.isFailure)
        assertEquals(1, scene.services.berths!!.size); assertEquals(4, scene.services.activity!!.size)
    }

    /** Entry-discrimination fixture only; full candidate-graph admission has its
     * independent renderer tests. This does not provide installed service pixels. */
    private fun serviceEntryCatalogue(version: Int = 15) = JsonObject(render + buildJsonObject {
        put("rendererContractVersion", version)
        put("entries", JsonArray(render.getValue("entries").jsonArray + types.map { type -> buildJsonObject {
            put("type", type); put("level", 1); put("footprintWidth", 2); put("footprintHeight", 2)
            put("phaseE", buildJsonObject { put("facility", type); put("tier", if(type == "berth") JsonNull else JsonPrimitive(1)) })
        } }))
    })
    // Deliberately synthetic bounds prove the mapper consumes exported constants;
    // these are not native copies of current game tuning.
    private val serviceCatalogue = JsonObject(catalogue + ("constants" to JsonObject(catalogue.getValue("constants").jsonObject + buildJsonObject {
        put("ART_V2", buildJsonObject { put("tiers", 4); put("levelsPerTier", 2) })
        put("STRUCTURES", buildJsonObject { types.forEach { type -> put(type, buildJsonObject {
            put("maxLevel", 7); put("footprint", buildJsonArray { add(2); add(2) })
        }) } })
    })))
    @Test fun `explicit candidate entries carry logical service identities without any guessed static frame realm or berth family`() {
        val scene = SceneMapper(serviceCatalogue,serviceEntryCatalogue()).baseScene(home(false))
        assertEquals(types,scene.buildings.map { it.service!!.facility })
        assertEquals(listOf(1,1,1,1,null),scene.buildings.map { it.service!!.tier })
        assertTrue(scene.buildings.all { it.frameKey == "service:${it.type}:1" })
        assertTrue(scene.buildings.all { it.footprintWidth == 2f && it.footprintHeight == 2f })
        assertEquals(false,scene.services.phaseEArtEnabled)
    }
    @Test fun `legacy or mismatched candidate entry cannot bypass explicit service discrimination`() {
        assertThrows(IllegalArgumentException::class.java) { SceneMapper(serviceCatalogue,serviceEntryCatalogue(14)).baseScene(home()) }
        val candidate=serviceEntryCatalogue()
        val rows=candidate.getValue("entries").jsonArray.map { row ->
            if(row.jsonObject["type"] == JsonPrimitive("workshop")) JsonObject(row.jsonObject + ("frameKey" to JsonPrimitive("invented-fallback"))) else row
        }
        assertThrows(IllegalArgumentException::class.java) {
            SceneMapper(serviceCatalogue,JsonObject(candidate + ("entries" to JsonArray(rows)))).baseScene(home())
        }
    }
    @Test fun `service footprints cannot override admitted geometry in current or frozen scenes`() {
        val candidate = SceneMapper(serviceCatalogue, serviceEntryCatalogue())
        for (bad in listOf(JsonPrimitive(1), JsonPrimitive(3), JsonPrimitive("2"), JsonNull, JsonPrimitive(2.5))) {
            val raw = JsonObject(home() + ("buildings" to JsonArray(home().getValue("buildings").jsonArray.map { row ->
                JsonObject(row.jsonObject + ("fw" to bad))
            })))
            assertThrows(IllegalArgumentException::class.java) { candidate.baseScene(raw) }
            assertThrows(IllegalArgumentException::class.java) { candidate.liveScene(envelope(raw)) }
        }
        val exact = JsonObject(home() + ("buildings" to JsonArray(home().getValue("buildings").jsonArray.map { row ->
            JsonObject(row.jsonObject + buildJsonObject { put("fw", 2); put("fh", 2) })
        })))
        assertTrue(candidate.baseScene(exact).buildings.all { it.footprintWidth == 2f && it.footprintHeight == 2f })
    }
    @Test fun `service scene binds tier and maximum level to exported constants without copying current game tuning`() {
        fun candidate(level: Int, tier: Int): Pair<SceneMapper, JsonObject> {
            val render = serviceEntryCatalogue()
            val rows = render.getValue("entries").jsonArray.map { row ->
                if (row.jsonObject["type"] == JsonPrimitive("workshop")) JsonObject(row.jsonObject + buildJsonObject {
                    put("level", level); put("phaseE", buildJsonObject { put("facility", "workshop"); put("tier", tier) })
                }) else row
            }
            val raw = JsonObject(home() + ("buildings" to JsonArray(home().getValue("buildings").jsonArray.map { row ->
                if (row.jsonObject["type"] == JsonPrimitive("workshop")) JsonObject(row.jsonObject + ("level" to JsonPrimitive(level))) else row
            })))
            return SceneMapper(serviceCatalogue, JsonObject(render + ("entries" to JsonArray(rows)))) to raw
        }
        val (valid, source) = candidate(4, 2)
        assertEquals(2, valid.baseScene(source).buildings.first().service!!.tier)
        for ((level, tier) in listOf(4 to 1, 8 to 4, 999 to 4)) {
            val (mapper, raw) = candidate(level, tier)
            assertThrows(IllegalArgumentException::class.java) { mapper.baseScene(raw) }
            assertThrows(IllegalArgumentException::class.java) { mapper.liveScene(envelope(raw)) }
        }
        val current=SceneMapper(catalogue,serviceEntryCatalogue()).baseScene(home())
        assertEquals("The actual promoted18 catalogue supplies service tuning",types,current.buildings.map { it.service!!.facility })
        val constants=catalogue.getValue("constants").jsonObject
        val missing=JsonObject(catalogue + ("constants" to JsonObject(constants + ("STRUCTURES" to
            JsonObject(constants.getValue("STRUCTURES").jsonObject.filterKeys { it !in types })))))
        assertThrows(IllegalArgumentException::class.java) { SceneMapper(missing, serviceEntryCatalogue()).baseScene(home()) }
    }


    // ---- Renderer16 (C4): the Awning projection reaches the renderer as facts ------------
    private fun hex(c: Char) = c.toString().repeat(64)
    private fun awningAppearance(tier: Int, binding: String = hex('a')) = buildJsonObject {
        put("version", 1); put("outputId", "artisan_market_awning_t$tier"); put("sourceId", "artisan-market-t$tier")
        put("sourceManifestSha256", hex('b')); put("sourceIndexSha256", hex('c')); put("bindingSha256", binding)
    }
    private fun projection(state: String = "available", vararg tiers: Pair<Int, Int>) = buildJsonObject {
        put("state", state)
        if (state == "available") put("visual", buildJsonObject { put("version", 1); put("marketAwnings", buildJsonArray {
            tiers.forEach { (n, tier) -> add(buildJsonObject { put("buildingId", id(n)); put("appearance", awningAppearance(tier)) }) } }) })
        else put("visual", JsonNull)
    }
    private fun homeWith(projection: JsonObject?, marketLevel: Int = 1) = JsonObject(home() + buildJsonObject {
        put("buildings", buildJsonArray { types.forEachIndexed { index, type -> add(buildJsonObject {
            put("id", id(index + 1)); put("type", type); put("level", if (type == "market") marketLevel else 1); put("tx", index + 3); put("ty", 4)
        }) } })
        if (projection != null) put("boundCosmetics", projection)
    })

    @Test fun `the injected tier rule mirrors the exported catalogue boundary and never a native table`() {
        val rule = mapper.completedMarketOutput()
        assertEquals("artisan_market_awning_t1", rule(1)); assertEquals("artisan_market_awning_t1", rule(5))
        assertEquals("artisan_market_awning_t2", rule(6)); assertEquals("artisan_market_awning_t4", rule(20))
        assertThrows(IllegalArgumentException::class.java) { rule(0) }
        assertThrows(IllegalArgumentException::class.java) { rule(21) }
    }
    @Test fun `a matching current projection becomes Awning facts and everything else leaves ordinary art`() {
        val market = 2 // types[1] == "market"
        val applied = mapper.baseScene(homeWith(projection("available", market to 1)))
        assertEquals(listOf(RenderMarketAwning(id(market), "artisan_market_awning_t1", hex('a'), hex('b'), hex('c'))), applied.services.awnings)
        assertEquals("the projection changes no geometry, footprint or frame identity", mapper.baseScene(home()).buildings, applied.buildings)
        assertNull("legacy absence", mapper.baseScene(homeWith(null)).services.awnings)
        assertNull("explicit unavailable", mapper.baseScene(homeWith(projection("unavailable"))).services.awnings)
        assertEquals(emptyList<RenderMarketAwning>(), mapper.baseScene(homeWith(projection("available"))).services.awnings)
        assertNull("unowned next tier on a level-1 Market", mapper.baseScene(homeWith(projection("available", market to 2))).services.awnings)
        // A level-6 Market (tier 2) needs its own catalogue entry in this wire-only fixture.
        val withLevel6 = SceneMapper(catalogue, JsonObject(fixtureRender + ("entries" to JsonArray(fixtureRender.getValue("entries").jsonArray +
            JsonObject(template + buildJsonObject { put("type", "market"); put("level", 6) })))))
        assertEquals("artisan_market_awning_t2", withLevel6.baseScene(homeWith(projection("available", market to 2), marketLevel = 6)).services.awnings?.single()?.outputId)
        assertNull("t1 on a level-6 Market is not its completed tier", withLevel6.baseScene(homeWith(projection("available", market to 1), marketLevel = 6)).services.awnings)
        assertNull("names the workshop", mapper.baseScene(homeWith(projection("available", 1 to 1))).services.awnings)
        assertNull("malformed", mapper.baseScene(homeWith(buildJsonObject { put("state", "applied") })).services.awnings)
        // The other facts keep flowing beside a refused projection.
        assertEquals(true, mapper.baseScene(homeWith(projection("unavailable"))).services.phaseEArtEnabled)
    }
    @Test fun `frozen battles carry only the envelope's frozen projection never the snapshot's current one`() {
        val market = 2
        val frozen = JsonObject(envelope(snapshot = homeWith(projection("unavailable"))) + buildJsonObject { put("boundCosmeticVisual", projection("available", market to 1)) })
        for (scene in listOf(mapper.previewScene(frozen, catalogue.getValue("simVersion").jsonPrimitive.int), mapper.liveScene(frozen))) {
            assertEquals("artisan_market_awning_t1", scene.base.services.awnings?.single()?.outputId)
            assertNull(scene.base.services.activity)
        }
        val current = mapper.liveScene(envelope(snapshot = homeWith(projection("available", market to 1))))
        assertNull("the inner snapshot's current field is not frozen history", current.base.services.awnings)
        val refused = JsonObject(envelope() + buildJsonObject { put("boundCosmeticVisual", projection("available", market to 2)) })
        assertNull(mapper.liveScene(refused).base.services.awnings)
    }


    // ---- N-C5-FACTS: the typed CURRENT advanced projection reaches the renderer as DISTINCT facts ----------
    private val wireFamilies = listOf("survey_balloon", "cargo_cutter", "courier_airship", "expedition_barge")
    private fun advancedRow(n: Int, family: String?, tier: Int = 1, presence: String = "occupied") = buildJsonObject {
        put("buildingId", id(n)); put("installation", family?.let { buildJsonObject { put("family", it); put("tier", tier); put("presence", presence) } } ?: JsonNull)
    }
    private fun advanced(vararg rows: JsonObject, version: Int = 1) = buildJsonObject { put("version", version); put("berths", buildJsonArray { rows.forEach { add(it) } }) }
    /** The ordinary wire-only home (berth id(5), level 1) with an advanced section and the given starter sibling (null = absent). */
    private fun homeAdvanced(advanced: JsonElement?, starter: JsonElement? = presentation(), enabled: Boolean = true): JsonObject {
        val base = JsonObject(home(enabled) + buildJsonObject { if (advanced != null) put("advancedServicePresentation", advanced) })
        return if (starter == null) JsonObject(base - "servicePresentation") else JsonObject(base + ("servicePresentation" to starter))
    }
    private val fixtureRows = advanced(advancedRow(5, "survey_balloon", 1, "away"))
    private fun advancedOf(scene: BaseScene) = scene.services.currentAdvancedBerths

    @Test fun `every accepted advanced family tier and presence survives current mapping exactly - wire names kept, nothing inferred from level timers or permission`() {
        for (family in wireFamilies) for (tier in 1..4) for ((wire, presence) in listOf("occupied" to RenderAdvancedPresence.OCCUPIED, "away" to RenderAdvancedPresence.AWAY, "exhausted" to RenderAdvancedPresence.EXHAUSTED)) {
            for (enabled in listOf(true, false)) {
                val scene = mapper.baseScene(homeAdvanced(advanced(advancedRow(5, family, tier, wire)), starter = presentation(null), enabled = enabled))
                assertEquals("$family t$tier $wire", listOf(RenderAdvancedBerth(id(5), RenderAdvancedInstallation(family, tier, presence))), advancedOf(scene))
                assertNull("the starter sibling stays its own explicit null installation", scene.services.berths!!.single().installation)
                assertEquals(enabled, scene.services.phaseEArtEnabled)
                assertEquals("the berth building is level 1 whatever the installed tier", 1, scene.buildings.single { it.type == "berth" }.level)
                assertEquals(mapper.baseScene(home(enabled)).buildings, scene.buildings)
            }
        }
    }
    @Test fun `null section null installation and a known empty closure stay distinct - malformed or missing later data retains no earlier positive`() {
        assertNull("absent section = unknown", advancedOf(mapper.baseScene(homeAdvanced(null))))
        assertEquals(RenderStarterPresence.AWAY, mapper.baseScene(homeAdvanced(null)).services.berths!!.single().installation!!.presence)
        assertEquals(listOf(RenderAdvancedBerth(id(5), null)), advancedOf(mapper.baseScene(homeAdvanced(advanced(advancedRow(5, null))))))
        // A home without a berth has a known EMPTY advanced closure (and an empty starter closure), not an unknown one.
        val noBerth = JsonObject(home() + buildJsonObject {
            put("buildings", buildJsonArray { types.filter { it != "berth" }.forEachIndexed { index, type -> add(buildJsonObject {
                put("id", id(index + 1)); put("type", type); put("level", 1); put("tx", index + 3); put("ty", 4) }) } })
            put("servicePresentation", buildJsonObject { put("version", 1); put("berths", buildJsonArray {}) })
            put("advancedServicePresentation", advanced())
        })
        assertEquals(emptyList<RenderAdvancedBerth>(), advancedOf(mapper.baseScene(noBerth))); assertEquals(emptyList<RenderBerthPresentation>(), mapper.baseScene(noBerth).services.berths)
        // Initial construction (level 0, underConstruction) stays in the current closure with a null installation only.
        // The level-0 berth entry below is test-only catalogue metadata (the existing fixture-entry pattern), not installed-art proof.
        val constructionMapper = SceneMapper(catalogue, JsonObject(fixtureRender + ("entries" to JsonArray(fixtureRender.getValue("entries").jsonArray +
            JsonObject(template + buildJsonObject { put("type", "berth"); put("level", 0) })))))
        val construction = JsonObject(homeAdvanced(advanced(advancedRow(5, null)), starter = presentation(null)) + ("buildings" to JsonArray(home().getValue("buildings").jsonArray.map { row ->
            if (row.jsonObject["type"] == JsonPrimitive("berth")) JsonObject(row.jsonObject + buildJsonObject { put("level", 0); put("underConstruction", true) }) else row })))
        val site = constructionMapper.baseScene(construction)
        assertEquals(listOf(RenderAdvancedBerth(id(5), null)), advancedOf(site)); assertTrue(site.buildings.single { it.type == "berth" }.underConstruction)
        assertNull("an installed craft on a construction site is refused as a whole", advancedOf(constructionMapper.baseScene(JsonObject(construction + ("advancedServicePresentation" to fixtureRows)))))
        // Malformed or foreign current data maps to unknown; the ordinary siblings keep their own accepted semantics.
        for (bad in listOf<JsonElement>(advanced(advancedRow(5, "survey_balloon"), version = 2), advanced(advancedRow(5, "zeppelin")), advanced(advancedRow(5, "survey_balloon", tier = 5)),
            advanced(advancedRow(5, "survey_balloon", presence = "docked")), advanced(advancedRow(4, "survey_balloon")), advanced(), JsonPrimitive("away"))) {
            val scene = mapper.baseScene(homeAdvanced(bad))
            assertNull("refused: $bad", advancedOf(scene))
            assertEquals(RenderStarterPresence.AWAY, scene.services.berths!!.single().installation!!.presence); assertEquals(true, scene.services.phaseEArtEnabled); assertEquals(4, scene.services.activity!!.size)
        }
        // A stateless later map never carries an earlier positive forward.
        assertNotNull(advancedOf(mapper.baseScene(homeAdvanced(fixtureRows)))); assertNull(advancedOf(mapper.baseScene(homeAdvanced(null))))
    }
    @Test fun `two installed siblings are preserved honestly and a missing sibling neither defaults nor erases the other`() {
        val both = mapper.baseScene(homeAdvanced(fixtureRows, starter = presentation("occupied")))
        assertEquals(RenderStarterInstallation("starter", RenderStarterPresence.OCCUPIED), both.services.berths!!.single().installation)
        assertEquals(RenderAdvancedInstallation("survey_balloon", 1, RenderAdvancedPresence.AWAY), advancedOf(both)!!.single().installation)
        val advancedOnly = mapper.baseScene(homeAdvanced(fixtureRows, starter = null))
        assertNull("absent starter section stays unknown", advancedOnly.services.berths); assertNotNull(advancedOf(advancedOnly)!!.single().installation)
        val starterOnly = mapper.baseScene(homeAdvanced(null))
        assertNull(advancedOf(starterOnly)); assertNotNull(starterOnly.services.berths!!.single().installation)
    }
    @Test fun `live battle preview scout and archive never populate the current-only advanced field even from valid frozen or nested current facts`() {
        val nested = homeAdvanced(fixtureRows)
        val frozen = JsonObject(envelope(snapshot = nested) + ("advancedServicePresentation" to fixtureRows))
        for (scene in listOf(mapper.previewScene(frozen, catalogue.getValue("simVersion").jsonPrimitive.int), mapper.liveScene(frozen))) {
            assertNull("frozen advanced facts never become current journey facts", advancedOf(scene.base))
            assertEquals("existing frozen starter behaviour unchanged", RenderStarterPresence.OCCUPIED, scene.base.services.berths!!.single().installation!!.presence)
            assertNull(scene.base.services.activity); assertNull(scene.base.services.phaseEArtEnabled)
        }
        assertNull(advancedOf(mapper.scoutScene(nested, "defender", catalogue.getValue("simVersion").jsonPrimitive.int).base))
        val recorded = json("src/debug/assets/native/fixtures/replay.json")
        assertNull(advancedOf(mapper.replayScene(JsonObject(recorded + frozen + ("events" to recorded.getValue("events")))).base))
    }
    @Test fun `the current advanced list is owned and cannot mutate a prepared generation`() {
        val scene = mapper.baseScene(homeAdvanced(fixtureRows))
        assertTrue(runCatching { (scene.services.currentAdvancedBerths as MutableList).clear() }.isFailure)
        assertEquals(1, scene.services.currentAdvancedBerths!!.size)
    }

    /** The PINNED authenticated primary `/base` response bodies (network/src/test/resources/advanced/current-base-http-pair.json),
     *  read in place and digest-checked; the bytes are never modified or copied. */
    private val currentPair: JsonObject by lazy {
        val relative = "network/src/test/resources/advanced/current-base-http-pair.json"
        val file = listOf(File(relative), File("../$relative")).first { it.isFile }
        val bytes = file.readBytes()
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
        assertEquals("pinned current fixture", "7319222336da771e9862de7d6874ea9ba809891966d4313a4f74266935343921", digest)
        Json.parseToJsonElement(String(bytes, Charsets.UTF_8)).jsonObject
    }
    private fun pinnedBody(name: String) = Json.parseToJsonElement(currentPair.getValue(name).jsonPrimitive.content).jsonObject
    @Test fun `the pinned current responses map the overdue-away then accepted-return transition and the null construction row through baseScene`() {
        val overdue = pinnedBody("overdueAway"); val returned = pinnedBody("returned")
        // Test-only catalogue entries for the bodies' unchanged building rows (including the level-0 construction berth):
        // the existing fixture-entry pattern, labelled metadata only — no installed-art proof.
        val present = fixtureRender.getValue("entries").jsonArray.map { it.jsonObject.getValue("type").jsonPrimitive.content to it.jsonObject.getValue("level").jsonPrimitive.content }.toSet()
        val needed = (overdue.getValue("buildings").jsonArray + returned.getValue("buildings").jsonArray).map { it.jsonObject.getValue("type").jsonPrimitive.content to it.jsonObject.getValue("level").jsonPrimitive.content }.toSet() - present
        val pinnedMapper = SceneMapper(catalogue, JsonObject(fixtureRender + ("entries" to JsonArray(fixtureRender.getValue("entries").jsonArray +
            needed.map { (type, level) -> JsonObject(template + buildJsonObject { put("type", type); put("level", level.toInt()) }) }))))
        val sailing = "abd99df7-077b-4bd7-adb5-c95d9e00547d"; val site = "b02f60b8-053d-4cc3-9f2e-ef214b21ec44"
        val away = pinnedMapper.baseScene(overdue); val back = pinnedMapper.baseScene(returned)
        assertEquals(listOf(RenderAdvancedBerth(sailing, RenderAdvancedInstallation("survey_balloon", 1, RenderAdvancedPresence.AWAY)), RenderAdvancedBerth(site, null)), advancedOf(away))
        assertEquals(listOf(RenderAdvancedBerth(sailing, RenderAdvancedInstallation("survey_balloon", 1, RenderAdvancedPresence.OCCUPIED)), RenderAdvancedBerth(site, null)), advancedOf(back))
        for (scene in listOf(away, back)) {
            assertEquals("both starter sibling rows are explicit nulls", listOf(RenderBerthPresentation(sailing, null), RenderBerthPresentation(site, null)), scene.services.berths)
            assertNull("the bodies omit art permission", scene.services.phaseEArtEnabled)
            assertEquals(emptyList<RenderMarketAwning>(), scene.services.awnings)
            val construction = scene.buildings.single { it.id == site }; assertTrue(construction.underConstruction); assertEquals(0, construction.level)
            assertEquals(1, scene.buildings.single { it.id == sailing }.level)
            assertEquals("61f06311-f25a-4a35-966d-157010a4ed03", scene.baseId)
        }
        assertEquals("the transition changes presence only", away.services.copy(currentAdvancedBerths = null), back.services.copy(currentAdvancedBerths = null))
    }
}
