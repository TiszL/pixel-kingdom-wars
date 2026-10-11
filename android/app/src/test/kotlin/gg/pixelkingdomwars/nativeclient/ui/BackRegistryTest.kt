package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.BackRegistry
import org.junit.Assert.*
import org.junit.Test

/** Android Back mirrors the web registry: the highest enabled priority wins, whatever the composition order. */
class BackRegistryTest {
    @Test fun `the highest enabled priority handles back regardless of registration order`() {
        val registry = BackRegistry(); val fired = mutableListOf<String>()
        registry.register(BackPriority.SCREEN) { fired += "screen" }
        registry.register(BackPriority.BATTLE) { fired += "battle" }
        registry.register(BackPriority.SHEET) { fired += "sheet" }
        assertTrue(registry.dispatch()); assertEquals(listOf("sheet"), fired)
    }
    @Test fun `a disabled handler is skipped and re-enabled later`() {
        val registry = BackRegistry(); val fired = mutableListOf<String>()
        val sheet = registry.register(BackPriority.SHEET, enabled = false) { fired += "sheet" }
        registry.register(BackPriority.HOME) { fired += "home" }
        registry.dispatch(); assertEquals(listOf("home"), fired)
        sheet.enabled = true; registry.dispatch(); assertEquals(listOf("home", "sheet"), fired)
    }
    @Test fun `equal priorities resolve to the latest registration and unregister restores the previous`() {
        val registry = BackRegistry(); val fired = mutableListOf<String>()
        registry.register(BackPriority.SHEET) { fired += "first" }
        val second = registry.register(BackPriority.SHEET) { fired += "second" }
        registry.dispatch(); registry.unregister(second); registry.dispatch()
        assertEquals(listOf("second", "first"), fired); assertEquals(1, registry.size())
    }
    @Test fun `the world back chain runs card or search, realm map, globe selection, then the screen`() {
        // Plan §3.5: Back peels the world one layer at a time and only then leaves the tab. A realm card must close
        // before the map leaves, and the map must leave before the globe drops its selection, whatever the order the
        // layers were composed in.
        assertTrue(BackPriority.REALM_CARD > BackPriority.GLOBE_LIST && BackPriority.GLOBE_LIST > BackPriority.REALM_MAP)
        assertTrue(BackPriority.REALM_MAP > BackPriority.GLOBE_LAYERS && BackPriority.GLOBE_LAYERS > BackPriority.SCREEN)
        assertTrue("A scout prompt still beats every world layer", BackPriority.SCOUT > BackPriority.REALM_CARD)
        val registry = BackRegistry(); val fired = mutableListOf<String>()
        val layers = registry.register(BackPriority.GLOBE_LAYERS) { fired += "selection" }
        registry.register(BackPriority.SCREEN) { fired += "base" }
        val map = registry.register(BackPriority.REALM_MAP) { fired += "map" }
        val card = registry.register(BackPriority.REALM_CARD) { fired += "card" }
        registry.dispatch(); card.enabled = false
        registry.dispatch(); map.enabled = false
        registry.dispatch(); layers.enabled = false
        registry.dispatch()
        assertEquals(listOf("card", "map", "selection", "base"), fired)
    }
    @Test fun `nothing registered means the default navigation applies`() {
        assertFalse(BackRegistry().dispatch())
    }
    @Test fun `priorities mirror the web table`() {
        assertEquals(1000, BackPriority.CONFIRM); assertEquals(220, BackPriority.SHEET); assertEquals(160, BackPriority.LAYOUT_EDITOR)
        assertEquals(140, BackPriority.BATTLE); assertEquals(120, BackPriority.SCOUT); assertEquals(110, BackPriority.GLOBE_LIST); assertEquals(100, BackPriority.GLOBE_LAYERS)
        assertTrue("Sheets beat every screen-level and Home handler", BackPriority.SHEET > BackPriority.SCREEN && BackPriority.SCREEN > BackPriority.HOME)
        assertTrue("A confirm dialog beats a battle retreat prompt", BackPriority.CONFIRM > BackPriority.BATTLE)
    }
}
