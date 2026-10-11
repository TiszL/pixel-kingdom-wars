package gg.pixelkingdomwars.nativeclient.ui.sheets

import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/** Regression for the real AccountState selection fence, which advances before the base ID. */
class SheetScopeGenerationTest {
    private val scope = SheetScope("account-session-1", "base-A", baseSelectionGeneration = 7)

    @Test fun `selection epoch change clears before selected base id changes`() {
        val old = HomeSheetStacks(scope).push(Destination.Army())
        val next = old.forScope(scope.copy(baseSelectionGeneration = 8))
        assertTrue(next.kingdom.isEmpty)
        assertTrue(next.world.isEmpty)
        assertEquals(8L, next.scope.baseSelectionGeneration)
        assertEquals("base-A", next.scope.baseId)
    }

    @Test fun `coalesced A to B to A cannot revive either tab stack`() {
        val old = HomeSheetStacks(scope).push(Destination.Army()).selectTab(HomeTab.WORLD)
            .push(Destination.IslandRewards("seeker"))
        val after = old.forScope(scope.copy(baseSelectionGeneration = 9))
        assertEquals(HomeTab.KINGDOM, after.selectedTab)
        assertTrue(after.kingdom.isEmpty)
        assertTrue(after.world.isEmpty)
    }

    @Test fun `same complete identity retains live stack`() {
        val stack = HomeSheetStacks(scope).push(Destination.Mail)
        assertSame(stack, stack.forScope(scope.copy()))
    }

    @Test fun `saved selection generation must match before any destination is restored`() {
        val stack = SheetStack().push(Destination.Mail)
        val saved = stack.save(scope)
        assertEquals(Destination.Mail, SheetStack.restore(saved, scope).top?.destination)
        assertTrue(SheetStack.restore(saved, scope.copy(baseSelectionGeneration = 8)).isEmpty)
        assertTrue(HomeSheetStacks.restore(HomeSheetStacks(scope).push(Destination.Mail).save(),
            scope.copy(baseSelectionGeneration = 8)).active.isEmpty)
    }

    @Test fun `legacy scope without generation is only generation zero`() {
        val legacy = SheetScope("account-session-1", "base-A")
        val saved = SheetStack().push(Destination.Mail).save(legacy)
        assertEquals(Destination.Mail, SheetStack.restore(saved, legacy).top?.destination)
        assertTrue(SheetStack.restore(saved, scope).isEmpty)
    }

    @Test fun `selection generation refuses negative or malformed values`() {
        assertThrows(IllegalArgumentException::class.java) { scope.copy(baseSelectionGeneration = -1) }
        val saved = Json.parseToJsonElement(SheetStack().push(Destination.Mail).save(scope)).jsonObject
        for (generation in listOf(JsonPrimitive("7"), JsonPrimitive(-1), JsonPrimitive(7.5))) {
            val identity = JsonObject(saved.getValue("scope").jsonObject + ("baseSelectionGeneration" to generation))
            assertTrue(SheetStack.restore(JsonObject(saved + ("scope" to identity)).toString(), scope).isEmpty)
        }
    }

    @Test fun `selection generation retains full long precision`() {
        val large = scope.copy(baseSelectionGeneration = Long.MAX_VALUE)
        val saved = SheetStack().push(Destination.Mail).save(large)
        assertEquals(Destination.Mail, SheetStack.restore(saved, large).top?.destination)
        assertTrue(SheetStack.restore(saved, large.copy(baseSelectionGeneration = Long.MAX_VALUE - 1)).isEmpty)
    }
}
