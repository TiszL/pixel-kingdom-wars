package gg.pixelkingdomwars.nativeclient.ui.sheets

import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/** UX architecture sections 7–8. Pure source contracts; execution belongs to the content pipeline's queue. */
class SheetStackTest {
    private val scope = SheetScope(sessionId = "session-generation-1", baseId = "base-1")

    @Test fun `empty back is a no-op and has no sheet`() {
        val stack = SheetStack()
        assertTrue(stack.isEmpty)
        assertEquals(0, stack.depth)
        assertNull(stack.top)
        assertSame(stack, stack.pop())
        assertSame(stack, stack.updateTop(selectedTab = "ARMY"))
    }

    @Test fun `fourth push replaces only top and back unwinds in order`() {
        val stack = SheetStack().push(Destination.Army()).push(Destination.Research)
            .push(Destination.Heroes("vex")).push(Destination.Market())
        assertEquals(3, stack.depth)
        assertEquals(listOf(Destination.Army(), Destination.Research, Destination.Market()),
            stack.entries.map { it.destination })
        assertEquals(Destination.Research, stack.pop().top?.destination)
        assertEquals(Destination.Army(), stack.pop().pop().top?.destination)
        assertTrue(stack.pop().pop().pop().isEmpty)
    }

    @Test fun `replace swaps the current sheet without adding a back step`() {
        val parent = SheetEntry(Destination.Profile(), "HISTORY", 12, 27)
        val before = SheetStack().push(parent).push(Destination.Research)
        val after = before.replace(Destination.GoldForge(tab = "LEGACY"))
        assertEquals(2, after.depth)
        assertEquals(Destination.GoldForge(tab = "LEGACY"), after.top?.destination)
        assertEquals(parent, after.pop().top)
        assertEquals(Destination.Research, before.top?.destination)
        assertEquals(Destination.Mail, SheetStack().replace(Destination.Mail).top?.destination)
    }

    @Test fun `tab and scroll updates survive a child and do not become back steps`() {
        val parent = SheetStack().push(Destination.Army())
            .updateTop(selectedTab = "ARMY", scrollIndex = 8, scrollOffset = 39)
        val child = parent.push(Destination.Heroes("vex", "GEAR"))
            .updateTop(selectedTab = "SKILLS", scrollIndex = 2, scrollOffset = 10)
        assertEquals(1, parent.depth)
        assertEquals(SheetEntry(Destination.Army(), "ARMY", 8, 39), child.pop().top)
        assertEquals("SKILLS", child.top?.selectedTab)
        assertEquals(8, parent.top?.scrollIndex)
    }

    @Test fun `entry lists cannot mutate old or new stack snapshots`() {
        val input = mutableListOf(SheetEntry(Destination.Mail))
        val stack = SheetStack(input)
        input.clear()
        assertEquals(1, stack.depth)
        assertThrows(UnsupportedOperationException::class.java) {
            (stack.entries as MutableList<SheetEntry>).clear()
        }
        assertEquals(Destination.Mail, stack.top?.destination)
        assertEquals(2, stack.push(Destination.Research).depth)
        assertEquals(1, stack.depth)
    }

    @Test fun `invalid in-memory depth and scroll coordinates refuse`() {
        assertThrows(IllegalArgumentException::class.java) {
            SheetStack(List(4) { SheetEntry(Destination.Mail) })
        }
        assertThrows(IllegalArgumentException::class.java) { SheetEntry(Destination.Mail, scrollIndex = -1) }
        assertThrows(IllegalArgumentException::class.java) { SheetEntry(Destination.Mail, scrollOffset = -1) }
    }

    @Test fun `kingdom and world retain independent tab and scroll state`() {
        val kingdom = HomeSheetStacks(scope).push(Destination.Army())
            .updateTop(selectedTab = "ARMY", scrollIndex = 4, scrollOffset = 25)
        val world = kingdom.selectTab(HomeTab.WORLD).push(Destination.IslandRewards("seeker"))
        assertEquals(Destination.IslandRewards("seeker"), world.active.top?.destination)
        assertEquals(kingdom.kingdom, world.kingdom)
        val returned = world.selectTab(HomeTab.KINGDOM)
        assertEquals(SheetEntry(Destination.Army(), "ARMY", 4, 25), returned.active.top)
        assertEquals(Destination.IslandRewards("seeker"), returned.world.top?.destination)
        assertTrue(returned.pop().kingdom.isEmpty)
        assertEquals(1, returned.pop().world.depth)
    }

    @Test fun `legacy home tabs are never accepted as stack hosts`() {
        HomeTab.entries.filter { it != HomeTab.KINGDOM && it != HomeTab.WORLD }.forEach { legacy ->
            assertThrows(IllegalArgumentException::class.java) { HomeSheetStacks(scope, selectedTab = legacy) }
            assertThrows(IllegalArgumentException::class.java) { HomeSheetStacks(scope).selectTab(legacy) }
        }
    }

    @Test fun `world handoff goes to kingdom and cannot return to old sheet histories`() {
        val target = Destination.FocusBuilding("lodge", then = Destination.Lodge(routeId = "route-7"))
        val before = HomeSheetStacks(scope).push(Destination.Profile()).selectTab(HomeTab.WORLD)
            .push(Destination.IslandRewards("seeker"))
        val after = before.handoffHome(target)
        assertEquals(HomeTab.KINGDOM, after.selectedTab)
        assertEquals(target, after.active.top?.destination)
        assertEquals(1, after.kingdom.depth)
        assertTrue(after.world.isEmpty)
        assertTrue(after.pop().active.isEmpty)
        assertTrue(after.pop().selectTab(HomeTab.WORLD).active.isEmpty)
        assertEquals(1, before.world.depth)
    }

    @Test fun `same scope retains stacks and changing either identity clears before rendering`() {
        val open = HomeSheetStacks(scope).push(Destination.Army()).selectTab(HomeTab.WORLD)
            .push(Destination.IslandRewards("seeker"))
        assertSame(open, open.forScope(scope.copy()))
        listOf(scope.copy(sessionId = "session-generation-2"), scope.copy(baseId = "base-2")).forEach { changed ->
            val cleared = open.forScope(changed)
            assertEquals(changed, cleared.scope)
            assertEquals(HomeTab.KINGDOM, cleared.selectedTab)
            assertTrue(cleared.kingdom.isEmpty)
            assertTrue(cleared.world.isEmpty)
        }
        assertTrue(open.clear().kingdom.isEmpty)
        assertTrue(open.clear().world.isEmpty)
    }

    @Test fun `save restores parent tabs and scroll as recovery hints only`() {
        val before = SheetStack().push(SheetEntry(Destination.Army(), "ARMY", 7, 34))
            .push(SheetEntry(Destination.GoldForge(tab = "LEGACY"), "LEGACY", 2, 8))
        val restored = SheetStack.restore(before.save(scope), scope)
        assertEquals(before.entries.map { it.destination }, restored.entries.map { it.destination })
        assertEquals(before.entries.map { it.selectedTab }, restored.entries.map { it.selectedTab })
        assertEquals(before.entries.map { it.scrollIndex to it.scrollOffset },
            restored.entries.map { it.scrollIndex to it.scrollOffset })
        assertTrue(restored.entries.all { it.restored })
        assertFalse(before.entries.any { it.restored })
        assertEquals("ARMY", restored.pop().top?.selectedTab)
    }

    @Test fun `save has a closed presentation schema with no seal money or mutation material`() {
        val saved = Json.parseToJsonElement(SheetStack().push(Destination.GoldForge(tab = "CLAIM")).save(scope)).jsonObject
        assertEquals(setOf("version", "scope", "entries"), saved.keys)
        assertEquals(setOf("sessionId", "baseId"), saved.getValue("scope").jsonObject.keys)
        assertEquals(setOf("destination", "selectedTab", "scrollIndex", "scrollOffset"),
            saved.getValue("entries").jsonArray.single().jsonObject.keys)
        val injected = JsonObject(saved + ("seal" to JsonObject(mapOf("armed" to JsonPrimitive(true)))) +
            ("idempotencyKey" to JsonPrimitive("not-a-sheet-field")))
        val restored = SheetStack.restore(injected.toString(), scope)
        assertEquals(Destination.GoldForge(tab = "CLAIM"), restored.top?.destination)
        assertTrue(restored.top!!.restored)
        assertFalse(restored.save(scope).contains("not-a-sheet-field"))
        assertFalse(restored.save(scope).contains("seal"))
    }

    @Test fun `focus commands and their child suffix are never replayed from saved state`() {
        val stack = SheetStack().push(Destination.Mail)
            .push(Destination.FocusBuilding("lodge", then = Destination.Lodge(routeId = "route-7")))
            .push(Destination.Research)
        val restored = SheetStack.restore(stack.save(scope), scope)
        assertEquals(listOf(Destination.Mail), restored.entries.map { it.destination })
        assertEquals(3, stack.depth)
        assertTrue(SheetStack.restore(SheetStack().push(Destination.FocusBuilding("keep")).save(scope), scope).isEmpty)
    }

    @Test fun `saved stack is rejected for another session or base`() {
        val saved = SheetStack().push(Destination.Mail).save(scope)
        assertTrue(SheetStack.restore(saved, scope.copy(sessionId = "other-session")).isEmpty)
        assertTrue(SheetStack.restore(saved, scope.copy(baseId = "other-base")).isEmpty)
    }

    @Test fun `malformed unsupported and absent saved stack restore empty`() {
        for (saved in listOf(null, "", "not json", "[]", "{}", "{\"version\":2}")) {
            assertTrue("saved=$saved", SheetStack.restore(saved, scope).isEmpty)
        }
        val saved = Json.parseToJsonElement(SheetStack().push(Destination.Mail).save(scope)).jsonObject
        assertTrue(SheetStack.restore(JsonObject(saved + ("version" to JsonPrimitive(2))).toString(), scope).isEmpty)
        assertTrue(SheetStack.restore(JsonObject(saved - "scope").toString(), scope).isEmpty)
    }

    @Test fun `unknown destination discards its child suffix while retaining a valid parent`() {
        val saved = threeSavedEntries()
        val entries = saved.getValue("entries").jsonArray.toMutableList()
        entries[1] = JsonObject(entries[1].jsonObject +
            ("destination" to JsonObject(mapOf("type" to JsonPrimitive("future.SealConfirmation")))))
        val restored = SheetStack.restore(JsonObject(saved + ("entries" to JsonArray(entries))).toString(), scope)
        assertEquals(listOf(Destination.Army()), restored.entries.map { it.destination })
        assertTrue(restored.top!!.restored)
    }

    @Test fun `malformed destination discards its child suffix without inventing a default route`() {
        val saved = threeSavedEntries()
        val entries = saved.getValue("entries").jsonArray.toMutableList()
        entries[1] = JsonObject(entries[1].jsonObject + ("destination" to JsonPrimitive("Mail")))
        assertEquals(listOf(Destination.Army()),
            SheetStack.restore(JsonObject(saved + ("entries" to JsonArray(entries))).toString(), scope)
                .entries.map { it.destination })
    }

    @Test fun `invalid scroll state discards entry and descendants`() {
        val saved = threeSavedEntries()
        val entries = saved.getValue("entries").jsonArray.toMutableList()
        entries[1] = JsonObject(entries[1].jsonObject + ("scrollIndex" to JsonPrimitive(-1)))
        assertEquals(1, SheetStack.restore(JsonObject(saved + ("entries" to JsonArray(entries))).toString(), scope).depth)
    }

    @Test fun `forged focus command is not executed by restore`() {
        val focus = Destination.FocusBuilding("goldforge", then = Destination.GoldForge(tab = "CLAIM"))
        val destination = Json.encodeToJsonElement(Destination.serializer(), focus)
        val saved = threeSavedEntries()
        val entries = saved.getValue("entries").jsonArray.toMutableList()
        entries[0] = JsonObject(entries[0].jsonObject + ("destination" to destination))
        assertTrue(SheetStack.restore(JsonObject(saved + ("entries" to JsonArray(entries))).toString(), scope).isEmpty)
    }

    @Test fun `saved state cannot override restored hint or exceed depth cap`() {
        val saved = threeSavedEntries()
        val entries = saved.getValue("entries").jsonArray.toMutableList()
        entries[0] = JsonObject(entries[0].jsonObject + ("restored" to JsonPrimitive(false)))
        val restored = SheetStack.restore(JsonObject(saved + ("entries" to JsonArray(entries))).toString(), scope)
        assertTrue(restored.entries.all { it.restored })
        entries.add(entries.last())
        assertTrue(SheetStack.restore(JsonObject(saved + ("entries" to JsonArray(entries))).toString(), scope).isEmpty)
    }

    @Test fun `home save restores selected tab and both scoped stacks`() {
        val before = HomeSheetStacks(scope).push(Destination.Army()).updateTop(selectedTab = "ARMY", scrollIndex = 3)
            .selectTab(HomeTab.WORLD).push(Destination.IslandRewards("seeker"))
        val after = HomeSheetStacks.restore(before.save(), scope)
        assertEquals(HomeTab.WORLD, after.selectedTab)
        assertEquals(scope, after.scope)
        assertEquals(Destination.IslandRewards("seeker"), after.active.top?.destination)
        assertEquals("ARMY", after.kingdom.top?.selectedTab)
        assertEquals(3, after.kingdom.top?.scrollIndex)
        assertTrue(after.kingdom.top!!.restored)
        assertTrue(after.world.top!!.restored)
    }

    @Test fun `home saved scope mismatch clears both stacks and returns to kingdom`() {
        val saved = HomeSheetStacks(scope).push(Destination.Army()).selectTab(HomeTab.WORLD)
            .push(Destination.Mail).save()
        listOf(scope.copy(sessionId = "another-session"), scope.copy(baseId = "another-base")).forEach { changed ->
            val after = HomeSheetStacks.restore(saved, changed)
            assertEquals(changed, after.scope)
            assertEquals(HomeTab.KINGDOM, after.selectedTab)
            assertTrue(after.kingdom.isEmpty)
            assertTrue(after.world.isEmpty)
        }
    }

    @Test fun `unknown home tab or malformed home payload cannot render sheets`() {
        val saved = Json.parseToJsonElement(HomeSheetStacks(scope).push(Destination.Mail).save()).jsonObject
        val invalidTab = JsonObject(saved + ("selectedTab" to JsonPrimitive("OLD_MONEY_TAB")))
        for (value in listOf(null, "bad", "[]", invalidTab.toString())) {
            val restored = HomeSheetStacks.restore(value, scope)
            assertEquals(HomeTab.KINGDOM, restored.selectedTab)
            assertTrue(restored.kingdom.isEmpty)
            assertTrue(restored.world.isEmpty)
        }
    }

    private fun threeSavedEntries(): JsonObject = Json.parseToJsonElement(
        SheetStack().push(Destination.Army()).push(Destination.BuildingInfo("building-7"))
            .push(Destination.Research).save(scope)
    ).jsonObject
}
