package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ServicePresentationTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private fun building(n: Int, type: String) = buildJsonObject {
        put("id", id(n)); put("type", type); put("level", 1); put("tx", 3); put("ty", 4)
    }
    private val buildings = JsonArray(listOf(building(3,"lodge"), building(1,"workshop"), building(5,"berth"),
        building(4,"harvester"), building(2,"market")))
    private fun presentation(presence: String? = "away") = buildJsonObject {
        put("version", 1); put("berths", buildJsonArray { add(buildJsonObject {
            put("buildingId", id(5)); put("installation", presence?.let { buildJsonObject {
                put("family", "starter"); put("presence", it)
            } } ?: JsonNull)
        }) })
    }
    private fun activity(states: List<String> = listOf("ready", "idle", "working", "working")) = buildJsonObject {
        put("version", 1); put("services", buildJsonArray { states.forEachIndexed { index, state -> add(buildJsonObject {
            put("buildingId", id(index + 1)); put("state", state)
        }) } })
    }
    private fun base() = buildJsonObject {
        put("player", buildJsonObject { put("keepLevel", 1) }); put("buildings", buildings)
        put("features", buildJsonObject { put("phaseEArt", capability()); put("phaseEBuildings", buildJsonObject { put("version", 1); put("enabledTypes", buildJsonArray {}) }) })
        put("servicePresentation", presentation()); put("serviceActivity", activity())
    }
    private fun capability() = buildJsonObject { put("version", 1); put("enabled", true) }
    private fun rejects(action: () -> Unit) { assertTrue(runCatching(action).isFailure) }

    @Test fun `exact current facts remain independent of construction admission and reveal no extra data`() {
        val parsed = BaseSnapshot.from(base())
        assertEquals(true, parsed.phaseEArt?.enabled)
        assertEquals(StarterPresentation("starter", StarterPresence.AWAY), parsed.servicePresentation!!.berths.single().installation)
        assertEquals(listOf(ServiceActivityState.READY, ServiceActivityState.IDLE, ServiceActivityState.WORKING, ServiceActivityState.WORKING),
            parsed.serviceActivity!!.services.map { it.state })
        assertEquals(parsed.buildings.size, buildings.size)
        val disabled = JsonObject(base() + ("features" to buildJsonObject { put("phaseEArt", JsonObject(capability() + ("enabled" to JsonPrimitive(false)))) }))
        assertEquals(false, BaseSnapshot.from(disabled).phaseEArt?.enabled)
        assertEquals(parsed.serviceActivity, BaseSnapshot.from(disabled).serviceActivity)
        assertEquals(parsed.servicePresentation, BaseSnapshot.from(disabled).servicePresentation)
    }
    @Test fun `legacy absence and null preserve unknown rather than inventing uninstalled berths`() {
        for (value in listOf<JsonElement?>(null, JsonNull)) {
            val old = JsonObject(base() - "features" - "servicePresentation" - "serviceActivity" +
                if (value == null) emptyMap() else mapOf("servicePresentation" to value, "serviceActivity" to value))
            val parsed = BaseSnapshot.from(old)
            assertNull(parsed.phaseEArt); assertNull(parsed.servicePresentation); assertNull(parsed.serviceActivity)
        }
        assertNull(BaseServicePresentation.from(presentation(null), buildings).berths.single().installation)
        assertNotNull(BaseServicePresentation.optional(presentation(null), base()))
    }
    @Test fun `capability requires exact numeric version boolean and field vocabulary`() {
        for (change in listOf("version" to JsonPrimitive("1"), "version" to JsonPrimitive(2), "enabled" to JsonPrimitive("true"),
            "enabled" to JsonPrimitive(1), "wallet" to JsonPrimitive("private"))) {
            val invalid = JsonObject(capability() + change)
            rejects { PhaseEArtCapability.from(invalid) }
            assertNull(PhaseEArtCapability.optional(invalid))
        }
        for (invalid in listOf(JsonPrimitive(true), JsonArray(emptyList()), JsonObject(capability() - "enabled")))
            assertNull(PhaseEArtCapability.optional(invalid))
    }
    @Test fun `native capability does not coerce an unknown service flag or require it from old servers`() {
        val old = buildJsonObject { put("protocolVersion", 1); put("simVersion", 17) }
        assertNull(NativeCapabilities.from(old).phaseEArt)
        assertEquals(true, NativeCapabilities.from(JsonObject(old + ("phaseEArt" to capability()))).phaseEArt?.enabled)
        assertNull(NativeCapabilities.from(JsonObject(old + ("phaseEArt" to JsonObject(capability() + ("enabled" to JsonPrimitive("true")))))).phaseEArt)
    }
    @Test fun `berth rows bind exactly sorted unique canonical accompanying identities`() {
        val second = building(6, "berth")
        val owner = JsonArray(buildings + second)
        val row = presentation().getValue("berths").jsonArray.single().jsonObject
        val rows = listOf(row, JsonObject(row + ("buildingId" to JsonPrimitive(id(6)))))
        fun proof(values: List<JsonElement>) = JsonObject(presentation() + ("berths" to JsonArray(values)))
        assertEquals(listOf(id(5), id(6)), BaseServicePresentation.from(proof(rows), owner).berths.map { it.buildingId })
        for (values in listOf(rows.reversed(), listOf(row, row), rows.take(1), rows + row,
            listOf(row, JsonObject(row + ("buildingId" to JsonPrimitive(id(7))))))) rejects { BaseServicePresentation.from(proof(values), owner) }
        rejects { BaseServicePresentation.from(presentation(), JsonArray(buildings + building(5, "berth"))) }
        rejects { BaseServicePresentation.from(presentation(), JsonArray(buildings.filterNot { it.jsonObject["type"] == JsonPrimitive("berth") })) }
    }
    @Test fun `private receipt or future family fields cannot enter berth projection`() {
        val row = presentation().getValue("berths").jsonArray.single().jsonObject
        val installed = row.getValue("installation").jsonObject
        val badRows = listOf(JsonObject(row + ("wallet" to JsonPrimitive("private"))), JsonObject(row - "installation"),
            JsonObject(row + ("buildingId" to JsonPrimitive(id(5).replace("4000", "0000")))) ) +
            listOf("family" to JsonPrimitive("trade"), "presence" to JsonPrimitive("home"), "receipt" to JsonPrimitive("private")).map {
                JsonObject(row + ("installation" to JsonObject(installed + it)))
            }
        for (bad in badRows) rejects { BaseServicePresentation.from(JsonObject(presentation() + ("berths" to JsonArray(listOf(bad)))), buildings) }
        rejects { BaseServicePresentation.from(JsonObject(presentation() + ("version" to JsonPrimitive(2))), buildings) }
    }
    @Test fun `activity refuses invented ready automatic deliveries and market work`() {
        for (states in listOf(listOf("idle", "working", "idle", "idle"), listOf("idle", "idle", "ready", "idle"),
            listOf("idle", "idle", "idle", "ready"), listOf("busy", "idle", "idle", "idle")))
            rejects { BaseServiceActivity.from(activity(states), buildings) }
    }
    @Test fun `activity closure rejects wrong base missing extra duplicate unordered or private rows`() {
        val rows = activity().getValue("services").jsonArray
        for (values in listOf(rows.dropLast(1), rows + rows.first(), rows.reversed(), listOf(rows.first()) + rows.dropLast(1),
            rows.mapIndexed { index, row -> if(index == 0) JsonObject(row.jsonObject + ("buildingId" to JsonPrimitive(id(8)))) else row },
            rows.mapIndexed { index, row -> if(index == 0) JsonObject(row.jsonObject + ("sourceId" to JsonPrimitive("private"))) else row }))
            rejects { BaseServiceActivity.from(JsonObject(activity() + ("services" to JsonArray(values))), buildings) }
        rejects { BaseServiceActivity.from(activity(), JsonArray(buildings + building(1, "workshop"))) }
        rejects { BaseServiceActivity.from(JsonObject(activity() + ("version" to JsonPrimitive("1"))), buildings) }
    }
    @Test fun `invalid optional facts clear only their own positive observation`() {
        val invalid = JsonObject(base() + ("serviceActivity" to JsonObject(activity() + ("version" to JsonPrimitive(2)))))
        val parsed = BaseSnapshot.from(invalid)
        assertNull(parsed.serviceActivity); assertNotNull(parsed.servicePresentation); assertEquals(true, parsed.phaseEArt?.enabled)
        val invalidOwner = JsonObject(base() + ("buildings" to JsonArray(emptyList())))
        assertNull(BaseServiceFacts.current(invalidOwner).presentation); assertNull(BaseServiceFacts.current(invalidOwner).activity)
    }
    @Test fun `frozen head reads only root original berth facts against its own snapshot`() {
        val snapshot = base()
        val envelope = buildJsonObject { put("snapshot", snapshot); put("servicePresentation", presentation("occupied")); put("serviceActivity", activity()) }
        val parsed = PresentationHead.from(envelope)
        assertEquals(StarterPresence.OCCUPIED, parsed.servicePresentation!!.berths.single().installation!!.presence)
        assertNull(PresentationHead.from(JsonObject(envelope - "servicePresentation")).servicePresentation)
        assertNull(PresentationHead.from(JsonObject(envelope + ("snapshot" to JsonPrimitive("wrong")))).servicePresentation)
        val frozen = BaseServiceFacts.frozen(envelope, snapshot)
        assertNull(frozen.phaseEArt); assertNull(frozen.activity)
        assertEquals(parsed.servicePresentation, frozen.presentation)
    }
    @Test fun `scout head binds directly while legacy non-service identifiers remain compatible`() {
        assertEquals(StarterPresence.AWAY, PresentationHead.from(base()).servicePresentation!!.berths.single().installation!!.presence)
        val legacy = buildJsonObject { put("id", "old-fixture-id"); put("type", "keep") }
        val withLegacy = JsonArray(buildings + legacy)
        assertEquals(BaseServicePresentation.from(presentation(), buildings), BaseServicePresentation.from(presentation(), withLegacy))
        assertEquals(BaseServiceActivity.from(activity(), buildings), BaseServiceActivity.from(activity(), withLegacy))
    }
    @Test fun `parsed facts own immutable lists and cannot change when wire backing rows change`() {
        val backing = activity().toMutableMap()
        val proof = BaseServiceActivity.from(JsonObject(backing), buildings)
        backing["services"] = JsonArray(emptyList())
        assertEquals(4, proof.services.size)
        rejects { (proof.services as MutableList).clear() }
        val berths = BaseServicePresentation.from(presentation(), buildings).berths
        rejects { (berths as MutableList).clear() }
    }

    // ---- Renderer16 (C4): the Awning projection beside the service facts -------------
    private fun hex(c: Char) = c.toString().repeat(64)
    private fun appearance(tier: Int, binding: String = hex('a')) = buildJsonObject {
        put("version", 1); put("outputId", "artisan_market_awning_t$tier"); put("sourceId", "artisan-market-t$tier")
        put("sourceManifestSha256", hex('b')); put("sourceIndexSha256", hex('c')); put("bindingSha256", binding)
    }
    private fun read(state: String = "available", vararg awnings: JsonObject) = buildJsonObject {
        put("state", state)
        if (state == "available") put("visual", buildJsonObject { put("version", 1); put("marketAwnings", JsonArray(awnings.toList())) }) else put("visual", JsonNull)
    }
    private fun awning(n: Int, tier: Int, binding: String = hex('a')) = buildJsonObject { put("buildingId", id(n)); put("appearance", appearance(tier, binding)) }
    private val rule: (Long) -> String = { level -> "artisan_market_awning_t${(level - 1) / 5 + 1}" }
    private fun baseWith(cosmetics: JsonElement?, market: JsonObject = building(2, "market")) = JsonObject(base() + mapOf(
        "buildings" to JsonArray(listOf(building(3, "lodge"), building(1, "workshop"), building(5, "berth"), building(4, "harvester"), market)))
        + (cosmetics?.let { mapOf("boundCosmetics" to it) } ?: emptyMap()))

    @Test fun `current Awning projection is carried only when it matches the completed Market through the injected tier rule`() {
        val facts = BaseServiceFacts.current(baseWith(read("available", awning(2, 1))), rule)
        assertEquals("available", facts.boundCosmetics?.state)
        assertEquals(id(2), facts.boundCosmetics?.visual?.marketAwnings?.single()?.buildingId)
        assertEquals("artisan_market_awning_t1", facts.boundCosmetics?.visual?.marketAwnings?.single()?.appearance?.outputId)
        // Legacy absence is null; a verified-empty and an explicit unavailable read are kept as such.
        assertNull(BaseServiceFacts.current(baseWith(null), rule).boundCosmetics)
        assertEquals(0, BaseServiceFacts.current(baseWith(read("available")), rule).boundCosmetics?.visual?.marketAwnings?.size)
        assertEquals("unavailable", BaseServiceFacts.current(baseWith(read("unavailable")), rule).boundCosmetics?.state)
        // The other facts are untouched by the projection.
        assertEquals(true, facts.phaseEArt?.enabled); assertEquals(1, facts.presentation?.berths?.size)
    }

    @Test fun `mismatched unknown or malformed projections become unavailable never partial and never a claimed off`() {
        val level6 = JsonObject(building(2, "market") + mapOf("level" to JsonPrimitive(6)))
        for (raw in listOf(
            read("available", awning(2, 2)),                                   // unowned next tier on a level-1 Market
            read("available", awning(3, 1)),                                   // names the Lodge
            read("available", awning(9, 1)),                                   // names an unknown building
            read("available", awning(2, 1), awning(2, 1)),                     // duplicate Market
            buildJsonObject { put("state", "applied"); put("visual", JsonNull) }, // unknown state
            buildJsonObject { put("state", "available"); put("visual", buildJsonObject { put("version", 2); put("marketAwnings", JsonArray(emptyList())) }) },
            JsonPrimitive("available"),
        )) assertEquals("unavailable", BaseServiceFacts.current(baseWith(raw), rule).boundCosmetics?.state)
        // Under construction refuses; the completed tier for level 6 is t2, so t1 refuses and t2 matches.
        val constructing = JsonObject(building(2, "market") + mapOf("underConstruction" to JsonPrimitive(true)))
        assertEquals("unavailable", BaseServiceFacts.current(baseWith(read("available", awning(2, 1)), constructing), rule).boundCosmetics?.state)
        assertEquals("unavailable", BaseServiceFacts.current(baseWith(read("available", awning(2, 1)), level6), rule).boundCosmetics?.state)
        assertEquals("available", BaseServiceFacts.current(baseWith(read("available", awning(2, 2)), level6), rule).boundCosmetics?.state)
        // Without an injected rule an Awning can never be admitted (older pack), an empty visual still can.
        assertEquals("unavailable", BaseServiceFacts.current(baseWith(read("available", awning(2, 1))), null).boundCosmetics?.state)
        assertEquals("available", BaseServiceFacts.current(baseWith(read("available")), null).boundCosmetics?.state)
        // A string-typed level never coerces.
        val stringLevel = JsonObject(building(2, "market") + mapOf("level" to JsonPrimitive("1")))
        assertEquals("unavailable", BaseServiceFacts.current(baseWith(read("available", awning(2, 1)), stringLevel), rule).boundCosmetics?.state)
    }

    @Test fun `frozen projection rides the envelope and is matched against the frozen snapshot only`() {
        val snapshot = baseWith(null)
        val envelope = buildJsonObject { put("servicePresentation", presentation()); put("boundCosmeticVisual", read("available", awning(2, 1)))
            put("boundCosmetics", read("unavailable")) }
        val frozen = BaseServiceFacts.frozen(envelope, snapshot, rule)
        assertEquals("available", frozen.boundCosmetics?.state)
        assertEquals(id(2), frozen.boundCosmetics?.visual?.marketAwnings?.single()?.buildingId)
        assertNull(BaseServiceFacts.frozen(buildJsonObject { put("servicePresentation", presentation()) }, snapshot, rule).boundCosmetics)
        // The frozen projection never reads the snapshot's own current field nor a current base.
        val snapshotWithCurrent = JsonObject(snapshot + mapOf("boundCosmetics" to read("available", awning(2, 1))))
        assertNull(BaseServiceFacts.frozen(buildJsonObject { put("servicePresentation", presentation()) }, snapshotWithCurrent, rule).boundCosmetics)
        assertEquals("unavailable", BaseServiceFacts.frozen(buildJsonObject { put("boundCosmeticVisual", read("available", awning(2, 1))) }, null, rule).boundCosmetics?.state)
    }
}
