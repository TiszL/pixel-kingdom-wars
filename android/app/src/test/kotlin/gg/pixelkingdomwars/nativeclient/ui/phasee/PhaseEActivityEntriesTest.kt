package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.BackRegistry
import org.junit.Assert.*
import org.junit.Test

class PhaseEActivityEntriesTest {
    @Test fun `menu buttons wire live and receipt callbacks only for distinct history rows`() {
        val source = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/phasee/PhaseEActivityEntries.kt").readText()
        // Applies to every distinct door, including the five routed-scope doors if that scope is mounted later.
        val distinct = source.substringAfter("choices.forEach { activity ->", missingDelimiterValue = "")
            .substringAfter("if (registry.hasDistinctHistory(activity)) {", missingDelimiterValue = "")
            .substringBefore("} else ActivityButton", missingDelimiterValue = "")
        assertTrue("The paired buttons must stay inside the distinct-history branch", distinct.isNotBlank())
        // Rewritten 2026-10-06 (owner: no old dark buttons on the player path): the pair is now the kit SecondaryButton
        // (label first, then its callback). The rule it pins is unchanged: OPEN launches, RECEIPTS only chooses history.
        val buttons = Regex("""SecondaryButton\("([^"]+)", \{ ([^\n]+?) \}, Modifier""")
            .findAll(distinct).map { it.groupValues[1] to it.groupValues[2] }.toList()
        assertEquals(listOf(
            "OPEN" to "if (registry.expanded) registry.launch(activity)",
            "RECEIPTS" to "registry.choose(activity)"), buttons)
    }

    @Test fun `distinct receipt doors keep both live and history callbacks reachable and separate`() {
        val registry = PhaseEActivityRegistry()
        var live = 0; var history = 0
        registry.registerDoor(PhaseEActivity.KEEP_MARKET, Any(), { true }, { live++ }, { history++ })
        assertTrue(registry.hasDistinctHistory(PhaseEActivity.KEEP_MARKET))
        registry.open()
        assertTrue(registry.choose(PhaseEActivity.KEEP_MARKET))
        assertEquals(0, live); assertEquals(1, history)
        registry.open()
        assertTrue(registry.launch(PhaseEActivity.KEEP_MARKET))
        assertEquals(1, live); assertEquals(1, history)
        assertFalse(registry.expanded)
    }

    @Test fun `aliased activities retain one action while distinct doors expose two`() {
        val registry = PhaseEActivityRegistry()
        registry.register(PhaseEActivity.MINING, Any()) {}
        registry.registerDoor(PhaseEActivity.WORKSHOP, Any(), { true }, {}, {})
        assertFalse(registry.hasDistinctHistory(PhaseEActivity.MINING))
        assertTrue(registry.hasDistinctHistory(PhaseEActivity.WORKSHOP))
        assertFalse(registry.hasDistinctHistory(PhaseEActivity.VEHICLES))
        registry.dispose()
        assertFalse(registry.hasDistinctHistory(PhaseEActivity.WORKSHOP))
    }

    @Test fun `refused live door never blocks the independent receipt callback`() {
        val registry = PhaseEActivityRegistry()
        var history = 0
        registry.registerDoor(PhaseEActivity.PAID_EXPEDITIONS, Any(), { false },
            { error("Live admission was closed") }, { history++ })
        registry.open()
        assertFalse(registry.launch(PhaseEActivity.PAID_EXPEDITIONS))
        assertTrue(registry.expanded)
        assertTrue(registry.choose(PhaseEActivity.PAID_EXPEDITIONS))
        assertEquals(1, history)
    }

    @Test fun `empty or unavailable mounts do not create a launch action`() {
        val registry = PhaseEActivityRegistry()
        registry.open()
        assertFalse(registry.expanded)
        assertTrue(registry.available.isEmpty())
        assertFalse(registry.choose(PhaseEActivity.MINING))
    }

    @Test fun `discovery order does not move activities between visits`() {
        val registry = PhaseEActivityRegistry()
        registry.register(PhaseEActivity.FRAGMENTS, Any()) {}
        registry.register(PhaseEActivity.KEEP_MARKET, Any()) {}
        registry.register(PhaseEActivity.CHARTERS, Any()) {}
        assertEquals(listOf(PhaseEActivity.KEEP_MARKET, PhaseEActivity.CHARTERS, PhaseEActivity.FRAGMENTS), registry.available)
    }

    @Test fun `opening and closing the menu never opens a feature or a payment`() {
        val registry = PhaseEActivityRegistry()
        var actions = 0
        registry.register(PhaseEActivity.REALM_PERMITS, Any()) { actions++ }
        registry.open(); assertTrue(registry.expanded)
        registry.close(); assertFalse(registry.expanded)
        assertEquals(0, actions)
        assertEquals(listOf(PhaseEActivity.REALM_PERMITS), registry.available)
    }

    @Test fun `selection closes before original mount action and ignores a second tap`() {
        val registry = PhaseEActivityRegistry()
        var actions = 0
        registry.register(PhaseEActivity.VEHICLES, Any()) { assertFalse(registry.expanded); actions++ }
        registry.open()
        assertTrue(registry.choose(PhaseEActivity.VEHICLES))
        assertFalse(registry.choose(PhaseEActivity.VEHICLES))
        assertEquals(1, actions)
    }

    @Test fun `updated action replaces stale wallet or base closure`() {
        val registry = PhaseEActivityRegistry()
        val owner = Any()
        var destination: String? = null
        registry.register(PhaseEActivity.RESOURCES, owner) { destination = "previous" }
        registry.open()
        registry.register(PhaseEActivity.RESOURCES, owner) { destination = "current" }
        assertTrue(registry.choose(PhaseEActivity.RESOURCES))
        assertEquals("current", destination)
    }

    @Test fun `old mount disposal cannot erase the new recovery entry`() {
        val registry = PhaseEActivityRegistry()
        val original = Any(); val replacement = Any()
        var actions = 0
        registry.register(PhaseEActivity.SHARDS, original) { error("Retired mount invoked") }
        registry.register(PhaseEActivity.SHARDS, replacement) { actions++ }
        registry.unregister(PhaseEActivity.SHARDS, original)
        registry.open()
        assertTrue(registry.choose(PhaseEActivity.SHARDS))
        assertEquals(1, actions)
    }

    @Test fun `losing eligibility while open removes only that action`() {
        val registry = PhaseEActivityRegistry()
        val owner = Any()
        registry.register(PhaseEActivity.DIVINE_TRIALS, owner) { error("Unavailable mount invoked") }
        registry.register(PhaseEActivity.FRAGMENTS, Any()) {}
        registry.open()
        registry.unregister(PhaseEActivity.DIVINE_TRIALS, owner)
        assertFalse(registry.choose(PhaseEActivity.DIVINE_TRIALS))
        assertTrue(registry.expanded)
        assertEquals(listOf(PhaseEActivity.FRAGMENTS), registry.available)
    }

    @Test fun `last entry disposal closes the empty menu without invoking it`() {
        val registry = PhaseEActivityRegistry(); val owner = Any()
        registry.register(PhaseEActivity.FREE_KINGDOM, owner) { error("Disposed mount invoked") }
        registry.open(); registry.unregister(PhaseEActivity.FREE_KINGDOM, owner)
        assertFalse(registry.expanded)
        assertFalse(registry.choose(PhaseEActivity.FREE_KINGDOM))
    }

    @Test fun `retired session rejects delayed callbacks and cannot register again`() {
        val registry = PhaseEActivityRegistry()
        registry.register(PhaseEActivity.KEEP_MARKET, Any()) { error("Retired session invoked") }
        registry.open(); registry.dispose()
        registry.register(PhaseEActivity.KEEP_MARKET, Any()) { error("Retired session registered") }
        registry.open()
        assertFalse(registry.choose(PhaseEActivity.KEEP_MARKET))
        assertFalse(registry.expanded)
        assertTrue(registry.available.isEmpty())
    }

    @Test fun `session teardown cannot remove another wallets entries or selection`() {
        val previous = PhaseEActivityRegistry(); val current = PhaseEActivityRegistry()
        previous.register(PhaseEActivity.MINING, Any()) { error("Previous wallet invoked") }
        var actions = 0
        current.register(PhaseEActivity.MINING, Any()) { actions++ }
        previous.open(); current.open(); previous.dispose()
        assertTrue(current.expanded)
        assertTrue(current.choose(PhaseEActivity.MINING))
        assertEquals(1, actions)
    }

    @Test fun `back closes activities before returning to the parent screen`() {
        val entries = PhaseEActivityRegistry()
        entries.register(PhaseEActivity.TOURNAMENTS, Any()) {}
        entries.open()
        val back = BackRegistry(); var navigation = 0
        back.register(BackPriority.SCREEN) { navigation++ }
        val menu = back.register(BackPriority.SHEET) { entries.close() }
        assertTrue(back.dispatch()); assertFalse(entries.expanded); assertEquals(0, navigation)
        back.unregister(menu)
        assertTrue(back.dispatch()); assertEquals(1, navigation)
    }
}
