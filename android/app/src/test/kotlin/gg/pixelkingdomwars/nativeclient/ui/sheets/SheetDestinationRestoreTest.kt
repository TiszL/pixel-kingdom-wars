package gg.pixelkingdomwars.nativeclient.ui.sheets

import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/**
 * MS-B DestinationTest (tests-only 4be77339, producer 577ecd68) requires strict destination decoding.
 * Unknown navigation fields invalidate that entry and its children; outer presentation metadata is
 * still discarded. Uses the shared MS-B Destination directly, with no copied serializer or types.
 * Authored tests only; execution belongs to the content pipeline's queue.
 */
class SheetDestinationRestoreTest {
    private val scope = SheetScope("session-generation-1", "base-1", baseSelectionGeneration = 7)
    private val safeParent = SheetEntry(Destination.Army(), selectedTab = "ARMY", scrollIndex = 4, scrollOffset = 17)
    private val moneySurface = SheetEntry(Destination.GoldForge(tab = "GEMS"), selectedTab = "GEMS", scrollIndex = 2, scrollOffset = 9)
    private val child = SheetEntry(Destination.Research, scrollIndex = 1, scrollOffset = 3)

    @Test fun `unknown money fields inside a destination drop it and its suffix but retain the safe parent`() {
        val saved = savedStack()
        val fields = mapOf<String, JsonElement>(
            "price" to JsonObject(mapOf("amount" to JsonPrimitive("1"))),
            "quote" to JsonObject(mapOf("id" to JsonPrimitive("untrusted-quote"))),
            "armed" to JsonPrimitive(true),
            "armedAtMs" to JsonPrimitive(1),
            "idempotencyKey" to JsonPrimitive("untrusted-money-key"),
            "signature" to JsonPrimitive("untrusted-signature"),
            "wire" to JsonPrimitive("untrusted-wire"),
            "callback" to JsonPrimitive("untrusted-callback"),
        )
        for ((name, value) in fields) {
            val injected = injectDestination(saved, "entries", 1, name, value)
            val restored = SheetStack.restore(injected.toString(), scope)
            assertEquals(name, listOf(safeParent.copy(restored = true)), restored.entries)
            assertTrue(name, restored.pop().isEmpty)
        }
    }

    @Test fun `unknown generic destination fields are rejected including null values`() {
        for (value in listOf<JsonElement>(JsonPrimitive("future-panel"), JsonNull)) {
            val injected = injectDestination(savedStack(), "entries", 1, "futurePanelHint", value)
            assertEquals(listOf(safeParent.copy(restored = true)),
                SheetStack.restore(injected.toString(), scope).entries)
        }
    }

    @Test fun `an unknown field in the first destination leaves no child reachable`() {
        val injected = injectDestination(savedStack(), "entries", 0, "idempotencyKey", JsonPrimitive("untrusted-money-key"))
        val restored = SheetStack.restore(injected.toString(), scope)
        assertTrue(restored.isEmpty)
        assertNull(restored.top)
        assertTrue(restored.pop().isEmpty)
    }

    @Test fun `invalid inactive kingdom destination truncates only kingdom and preserves world selection`() {
        val before = homeStacks()
        val injected = injectDestination(Json.parseToJsonElement(before.save()).jsonObject,
            "kingdom", 1, "idempotencyKey", JsonPrimitive("untrusted-money-key"))
        val restored = HomeSheetStacks.restore(injected.toString(), scope)
        assertEquals(scope, restored.scope)
        assertEquals(HomeTab.WORLD, restored.selectedTab)
        assertEquals(listOf(safeParent.copy(restored = true)), restored.kingdom.entries)
        assertEquals(before.world.entries.map { it.copy(restored = true) }, restored.world.entries)
        assertEquals(restored.world, restored.active)
        assertEquals(safeParent.copy(restored = true), restored.selectTab(HomeTab.KINGDOM).active.top)
    }

    @Test fun `invalid active world destination truncates only world without losing kingdom history`() {
        val before = homeStacks()
        val injected = injectDestination(Json.parseToJsonElement(before.save()).jsonObject,
            "world", 1, "futurePanelHint", JsonPrimitive("future-panel"))
        val restored = HomeSheetStacks.restore(injected.toString(), scope)
        assertEquals(scope, restored.scope)
        assertEquals(HomeTab.WORLD, restored.selectedTab)
        assertEquals(before.kingdom.entries.map { it.copy(restored = true) }, restored.kingdom.entries)
        assertEquals(listOf(before.world.entries.first().copy(restored = true)), restored.world.entries)
        assertEquals(restored.world, restored.active)
        assertTrue(restored.pop().world.isEmpty)
        assertEquals(restored.kingdom, restored.pop().kingdom)
    }

    @Test fun `both home histories independently stop at their first invalid destination`() {
        val before = homeStacks()
        val invalidKingdom = injectDestination(Json.parseToJsonElement(before.save()).jsonObject,
            "kingdom", 1, "armed", JsonPrimitive(true))
        val invalidBoth = injectDestination(invalidKingdom, "world", 0, "idempotencyKey", JsonPrimitive("untrusted-money-key"))
        val restored = HomeSheetStacks.restore(invalidBoth.toString(), scope)
        assertEquals(HomeTab.WORLD, restored.selectedTab)
        assertEquals(listOf(safeParent.copy(restored = true)), restored.kingdom.entries)
        assertTrue(restored.world.isEmpty)
        assertTrue(restored.active.isEmpty)
        assertEquals(safeParent.copy(restored = true), restored.selectTab(HomeTab.KINGDOM).active.top)
    }

    @Test fun `outer envelope and entry metadata are sanitized without rejecting valid destinations`() {
        val before = stack()
        val clean = Json.parseToJsonElement(before.save(scope)).jsonObject
        val injected = withOuterMetadata(withEntryMetadata(clean, "entries"))
        val restored = SheetStack.restore(injected.toString(), scope)
        assertEquals(before.entries.map { it.copy(restored = true) }, restored.entries)
        assertEquals(clean, Json.parseToJsonElement(restored.save(scope)).jsonObject)
    }

    @Test fun `home sanitizes outer and entry metadata in both histories while retaining navigation state`() {
        val before = homeStacks()
        val clean = Json.parseToJsonElement(before.save()).jsonObject
        val injected = withOuterMetadata(withEntryMetadata(withEntryMetadata(clean, "kingdom"), "world"))
        val restored = HomeSheetStacks.restore(injected.toString(), scope)
        assertEquals(scope, restored.scope)
        assertEquals(HomeTab.WORLD, restored.selectedTab)
        assertEquals(before.kingdom.entries.map { it.copy(restored = true) }, restored.kingdom.entries)
        assertEquals(before.world.entries.map { it.copy(restored = true) }, restored.world.entries)
        assertEquals(clean, Json.parseToJsonElement(restored.save()).jsonObject)
    }

    private fun stack(): SheetStack = SheetStack(listOf(safeParent, moneySurface, child))

    private fun savedStack(): JsonObject = Json.parseToJsonElement(stack().save(scope)).jsonObject

    private fun homeStacks(): HomeSheetStacks = HomeSheetStacks(
        scope = scope,
        selectedTab = HomeTab.WORLD,
        kingdom = stack(),
        world = SheetStack(listOf(
            SheetEntry(Destination.IslandRewards("seeker"), selectedTab = "REWARDS", scrollIndex = 6, scrollOffset = 21),
            SheetEntry(Destination.Profile(tab = "WALLET"), selectedTab = "WALLET", scrollIndex = 3, scrollOffset = 12),
            SheetEntry(Destination.WalletHistory(home = "islands"), scrollIndex = 2, scrollOffset = 7),
        )),
    )

    private fun injectDestination(
        saved: JsonObject,
        history: String,
        index: Int,
        name: String,
        value: JsonElement,
    ): JsonObject {
        val entries = saved.getValue(history).jsonArray.toMutableList()
        val entry = entries[index].jsonObject
        val destination = JsonObject(entry.getValue("destination").jsonObject + (name to value))
        entries[index] = JsonObject(entry + ("destination" to destination))
        return JsonObject(saved + (history to JsonArray(entries)))
    }

    private fun withEntryMetadata(saved: JsonObject, history: String): JsonObject {
        val entries = saved.getValue(history).jsonArray.map { value ->
            JsonObject(value.jsonObject + mapOf(
                "restored" to JsonPrimitive(false),
                "idempotencyKey" to JsonPrimitive("untrusted-entry-key"),
                "seal" to JsonObject(mapOf("armed" to JsonPrimitive(true))),
                "futureEntryHint" to JsonPrimitive("discard-me"),
            ))
        }
        return JsonObject(saved + (history to JsonArray(entries)))
    }

    private fun withOuterMetadata(saved: JsonObject): JsonObject = JsonObject(saved + mapOf(
        "idempotencyKey" to JsonPrimitive("untrusted-envelope-key"),
        "seal" to JsonObject(mapOf("armed" to JsonPrimitive(true))),
        "futureEnvelopeHint" to JsonPrimitive("discard-me"),
    ))
}
