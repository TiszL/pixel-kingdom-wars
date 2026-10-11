package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.network.PhaseEConstructionArt
import gg.pixelkingdomwars.nativeclient.network.buildCountPresentation
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomLocal
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildCardState
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.CardTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.cardTap
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** c2c4324f: discovery must survive unavailable construction; all game numbers still come from the pack. */
class BuildTrayDiscoveryTest {
    private val types = listOf("workshop", "lodge", "berth", "harvester", "market", "goldforge")
    private fun fixture(name: String): JsonObject = Json.parseToJsonElement(
        requireNotNull(javaClass.getResourceAsStream("/iw3/$name")).bufferedReader().use { it.readText() }) as JsonObject

    private fun state(keep: Int = 5, buildings: List<Building> = emptyList(), admitted: Boolean = false): KingdomUiState {
        val raw = buildJsonObject {
            put("baseId", "b1")
            putJsonArray("buildings") { buildings.forEach { b -> addJsonObject {
                put("id", b.id); put("type", b.type); put("level", b.level)
            } } }
            putJsonObject("features") { putJsonObject("phaseEBuildings") {
                put("version", 1); putJsonArray("enabledTypes") { types.filter { it != "goldforge" }.forEach { add(it) } }
            } }
            putJsonObject("visualContext") { put("version", 1); put("realmId", "frostveil"); put("artVersion", 2) }
        }
        return KingdomUiState(home = BaseState(base = BaseSnapshot("b1", null, PlayerSummary(keepLevel = keep, builders = 2),
            null, null, null, buildings, emptyList(), emptyList(), 1, raw)),
            catalogue = fixture("catalogue.json"), renderCatalogue = fixture("render-catalog.json"),
            constructionArt = if (admitted) PhaseEConstructionArt { true } else null,
            local = KingdomLocal(buildMenu = true))
    }

    private fun realm(state: KingdomUiState, guarded: Boolean = false) = readTrayFacts(state, false)!!.let {
        if (guarded) liveBuildTrayUi(it, LiveTrayTabs.BUILDINGS, LiveBuildingCosts.unavailable())
        else liveBuildTrayUi(it, LiveTrayTabs.BUILDINGS)
    }.sections.first().also { assertEquals("REALM TRADE", it.title) }.cards

    @Test fun `Keep five discovers all six Realm Trade buildings without construction art`() {
        val state = state()
        assertTrue(state.phaseEBuildingChoices.isEmpty())
        val cards = realm(state)
        assertEquals(types, cards.map { it.type })
        assertEquals(listOf("WORKSHOP", "LODGE", "BERTH", "HARVESTER", "MARKET", "GOLD FORGE"), cards.map { it.name })
        assertEquals("ui:goldforge-t1-idle", cards.single { it.type == "goldforge" }.art)
        assertTrue(cards.all { it.purpose.isNotBlank() })
        for (card in cards) {
            val count = buildCountPresentation(state.catalogue!!, card.type, 5, emptyList())!!
            assertEquals("${count.owned}/${count.max}", card.count)
            if (card.type != "goldforge") {
                assertFalse(state.constructionAvailable(card.type))
                assertNotEquals(CardTap.PLACE, cardTap(card.state))
                assertEquals(BuildCardState.UNAVAILABLE, card.state)
                assertTrue(card.art.isNotBlank())
            }
        }
    }

    @Test fun `Keep lock remains visible and states the exact catalogue level`() {
        val state = state(keep = 1, admitted = true)
        assertEquals(types.filter { it != "goldforge" }.toSet(), state.phaseEBuildingChoices.toSet())
        val costs = state.catalogue!!["constants"]!!.jsonObject["BUILD_COSTS"]!!.jsonObject
        for (card in realm(state)) {
            val required = costs[card.type]!!.jsonObject["requiresKeepLevel"]!!.jsonPrimitive.int
            if (required > 1) {
                assertEquals(BuildCardState.LOCKED, card.state)
                assertEquals("Unlocks at Keep $required", card.reason)
                assertEquals(CardTap.EXPLAIN_LOCKED, cardTap(card.state))
            }
        }
    }

    @Test fun `server Berth zero cap survives missing art and cannot dispatch`() {
        val original = state()
        val base = original.base!!
        val raw = JsonObject(base.raw + ("constructionCapacity" to buildJsonObject {
            put("version", 1); putJsonObject("berth") { put("max", 0) }
        }))
        val card = realm(original.copy(home = original.home.copy(base = base.copy(raw = raw)))).single { it.type == "berth" }
        assertEquals("0/0", card.count)
        assertEquals(BuildCardState.UNAVAILABLE, card.state)
        assertEquals(CardTap.EXPLAIN_UNAVAILABLE, cardTap(card.state))
        assertEquals("Building unavailable right now", card.reason)
        assertNull(card.requires)
    }

    @Test fun `owned maximum stays visible with exact count while admission is unavailable`() {
        val original = state(keep = 5)
        val cap = buildCountPresentation(original.catalogue!!, "workshop", 5, emptyList())!!.max
        val owned = List(cap) { Building("w$it", "workshop", 1, it, 0) }
        val card = realm(state(buildings = owned)).single { it.type == "workshop" }
        assertEquals("$cap/$cap", card.count)
        assertEquals(BuildCardState.UNAVAILABLE, card.state)
        assertEquals(CardTap.EXPLAIN_UNAVAILABLE, cardTap(card.state))
        assertEquals("Building unavailable right now", card.reason)
    }

    @Test fun `missing price retains the card with an unavailable action and no invented amount`() {
        val original = state(admitted = true)
        val constants = original.catalogue!!["constants"]!!.jsonObject
        val catalogue = JsonObject(original.catalogue!! + ("constants" to JsonObject(constants +
            ("BUILD_COSTS" to JsonObject(constants["BUILD_COSTS"]!!.jsonObject - "workshop")))))
        val state = original.copy(catalogue = catalogue)
        val cards = realm(state)
        assertEquals(types, cards.map { it.type })
        val card = cards.single { it.type == "workshop" }
        assertEquals(BuildCardState.UNAVAILABLE, card.state)
        assertNull(card.price)
        assertNotEquals(CardTap.PLACE, cardTap(card.state))
    }

    @Test fun `initial loading lists six buildings without fabricating Keep counts costs or builders`() {
        val state = KingdomUiState(local = KingdomLocal(buildMenu = true))
        val facts = requireNotNull(readTrayFacts(state, false))
        val ui = liveBuildTrayUi(facts, LiveTrayTabs.BUILDINGS)
        assertEquals(types, ui.sections.first().cards.map { it.type })
        assertEquals("$UNKNOWN/$UNKNOWN", ui.builders)
        assertFalse(ui.buildersFree)
        ui.sections.first().cards.forEach {
            assertEquals("$UNKNOWN/$UNKNOWN", it.count)
            assertEquals(BuildCardState.UNAVAILABLE, it.state)
            assertNull(it.price)
        }
    }

    @Test fun `guarded mapper cannot turn discovery into construction permission`() {
        val state = state(admitted = true)
        val cards = realm(state, guarded = true)
        assertEquals(types, cards.map { it.type })
        cards.forEach { assertNotEquals(CardTap.PLACE, cardTap(it.state)) }
        val closed = state.copy(constructionArt = null)
        assertEquals(types, realm(closed, guarded = true).map { it.type })
        types.filter { it != "goldforge" }.forEach { assertFalse(closed.constructionAvailable(it)) }
    }

    @Test fun `unadmitted buildings never promise a Keep unlock in either mapper`() {
        val state = state(keep = 1)
        for (guarded in listOf(false, true)) {
            val cards = realm(state, guarded).filter { it.type != "goldforge" }
            assertEquals(types.size - 1, cards.size)
            cards.forEach {
                assertEquals(BuildCardState.UNAVAILABLE, it.state)
                assertEquals("Building unavailable right now", it.reason)
                assertEquals(CardTap.EXPLAIN_UNAVAILABLE, cardTap(it.state))
            }
        }
    }

    private fun withCaps(state: KingdomUiState, type: String, caps: JsonArray): KingdomUiState {
        val catalogue = state.catalogue!!
        val constants = catalogue["constants"]!!.jsonObject
        val table = constants["BUILD_COUNT_CAP_BY_KEEP"]!!.jsonObject
        return state.copy(catalogue = JsonObject(catalogue + ("constants" to JsonObject(constants +
            ("BUILD_COUNT_CAP_BY_KEEP" to JsonObject(table + (type to caps)))))))
    }

    @Test fun `MAX announces only the first future catalogue level that makes room for another building`() {
        // Synthetic retune: level six increases the cap but is still below this base's existing count.
        val owned = List(2) { Building("w$it", "workshop", 1, it, 0) }
        val state = withCaps(state(buildings = owned, admitted = true), "workshop",
            buildJsonArray { listOf(0, 0, 1, 1, 1, 2, 2, 3).forEach { add(it) } })
        val card = realm(state).single { it.type == "workshop" }
        assertEquals(BuildCardState.MAX, card.state)
        assertEquals("2/1", card.count)
        assertEquals("more at Keep 8", card.reason)
        assertEquals(CardTap.EXPLAIN_MAX, cardTap(card.state))
    }

    @Test fun `the current fixed cap table invents neither a later Keep nor a NEW badge`() {
        val state = state(buildings = listOf(Building("w1", "workshop", 1, 0, 0)), admitted = true)
        val cards = realm(state)
        val card = cards.single { it.type == "workshop" }
        assertEquals(BuildCardState.MAX, card.state)
        assertEquals("All built", card.reason)
        assertTrue(cards.none { it.isNew })
    }

    @Test fun `an advertised Berth cap cannot be lifted by a future catalogue row`() {
        val original = withCaps(state(buildings = listOf(Building("b2", "berth", 1, 0, 0)), admitted = true), "berth",
            buildJsonArray { listOf(0, 0, 0, 0, 1, 2).forEach { add(it) } })
        val base = original.base!!
        val raw = JsonObject(base.raw + ("constructionCapacity" to buildJsonObject {
            put("version", 1); putJsonObject("berth") { put("max", 1) }
        }))
        val card = realm(original.copy(home = original.home.copy(base = base.copy(raw = raw)))).single { it.type == "berth" }
        assertEquals(BuildCardState.MAX, card.state)
        assertEquals("1/1", card.count)
        assertEquals("All built", card.reason)
    }

    @Test fun `a malformed future cap leaves the future Keep unknown`() {
        val original = state(buildings = listOf(Building("w1", "workshop", 1, 0, 0)), admitted = true)
        for (malformed in listOf(JsonPrimitive("2"), JsonPrimitive(-1), JsonNull, JsonPrimitive(2.5))) {
            val state = withCaps(original, "workshop", buildJsonArray {
                listOf(0, 0, 1, 1, 1).forEach { add(it) }; add(malformed); add(3)
            })
            val card = readTrayFacts(state, false).cards.single { it.type == "workshop" }
            assertNull(card.nextCapKeep)
        }
    }
}
