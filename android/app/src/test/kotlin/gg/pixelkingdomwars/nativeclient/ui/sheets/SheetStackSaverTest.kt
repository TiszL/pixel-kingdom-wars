package gg.pixelkingdomwars.nativeclient.ui.sheets

import androidx.compose.runtime.saveable.SaverScope
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import org.junit.Assert.*
import org.junit.Test

class SheetStackSaverTest {
    private val scope = SheetScope("session-generation-1", "base-1", 3)
    private val stringsOnly = object : SaverScope {
        override fun canBeSaved(value: Any): Boolean = value is String
    }

    @Test fun `saver writes one Bundle-compatible string instead of destination objects`() {
        val saver = homeSheetStacksSaver(scope)
        val saved = requireNotNull(with(saver) { stringsOnly.save(HomeSheetStacks(scope).push(Destination.Mail)) })
        assertTrue(stringsOnly.canBeSaved(saved))
        assertEquals(Destination.Mail, saver.restore(saved)?.active?.top?.destination)
    }

    @Test fun `saver restores both tab histories and presentation as recovery hints`() {
        val saver = homeSheetStacksSaver(scope)
        val original = HomeSheetStacks(scope).push(Destination.Army()).updateTop(selectedTab = "ARMY", scrollIndex = 2)
            .selectTab(HomeTab.WORLD).push(Destination.IslandRewards("seeker"))
        val saved = requireNotNull(with(saver) { stringsOnly.save(original) })
        val restored = requireNotNull(saver.restore(saved))
        assertEquals(HomeTab.WORLD, restored.selectedTab)
        assertEquals("ARMY", restored.kingdom.top?.selectedTab)
        assertEquals(2, restored.kingdom.top?.scrollIndex)
        assertTrue(restored.kingdom.top!!.restored)
        assertTrue(restored.world.top!!.restored)
    }

    @Test fun `old callback state cannot be saved under a replacement scope`() {
        val old = HomeSheetStacks(scope).push(Destination.Mail)
        for (current in listOf(scope.copy(sessionId = "next-session"), scope.copy(baseId = "next-base"),
            scope.copy(baseSelectionGeneration = 4))) {
            val saver = homeSheetStacksSaver(current)
            assertNull(with(saver) { stringsOnly.save(old) })
        }
    }

    @Test fun `restoration checks current scope before returning a renderable history`() {
        val original = HomeSheetStacks(scope).push(Destination.Mail)
        val saved = requireNotNull(with(homeSheetStacksSaver(scope)) { stringsOnly.save(original) })
        val current = scope.copy(baseSelectionGeneration = 4)
        val restored = requireNotNull(homeSheetStacksSaver(current).restore(saved))
        assertEquals(current, restored.scope)
        assertEquals(HomeTab.KINGDOM, restored.selectedTab)
        assertTrue(restored.kingdom.isEmpty)
        assertTrue(restored.world.isEmpty)
    }

    @Test fun `corrupt saved input returns an empty scoped home`() {
        val restored = requireNotNull(homeSheetStacksSaver(scope).restore("invalid saved value"))
        assertEquals(scope, restored.scope)
        assertTrue(restored.active.isEmpty)
    }
}
