package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.ui.home.HomeBackAction
import gg.pixelkingdomwars.nativeclient.ui.home.homeBackAction
import gg.pixelkingdomwars.nativeclient.ui.nav.CatalogueTimings
import org.junit.Assert.*
import org.junit.Test

/** Home timings come only from the catalogue, by the names `packages/shared/src/constants.ts` exports
 * (`MOBILE_BACK.exitConfirmMs`, `WORLD.mapPollSec`). There is no declared default: a loaded pack that
 * lacks a key turns the feature it times off and says so, instead of running on an invented number. */
class CatalogueTimingsTest {
    private val full = json("""{"constants":{"MOBILE_BACK":{"exitConfirmMs":2000},"WORLD":{"mapPollSec":20}}}""")

    @Test fun `timings are read by their exported names and are absent when the pack lacks them`() {
        assertEquals(2000L, CatalogueTimings.exitConfirmMs(full)); assertEquals(20_000L, CatalogueTimings.homeRefreshMs(full))
        assertNull("A complete pack needs no notice", CatalogueTimings.compatibilityNotice(full))
        val stale = json("""{"constants":{"RAID_RULES":{"scoutPreviewSec":30}}}""")
        assertNull(CatalogueTimings.exitConfirmMs(stale)); assertNull(CatalogueTimings.homeRefreshMs(stale))
        assertTrue(CatalogueTimings.compatibilityNotice(stale)!!.contains("MOBILE_BACK.exitConfirmMs, WORLD.mapPollSec"))
        val partial = json("""{"constants":{"WORLD":{"mapPollSec":20}}}""")
        assertEquals(20_000L, CatalogueTimings.homeRefreshMs(partial))
        val notice = requireNotNull(CatalogueTimings.compatibilityNotice(partial))
        assertTrue(notice.contains("MOBILE_BACK.exitConfirmMs")); assertFalse(notice.contains("WORLD.mapPollSec"))
        assertNull("A non-positive timer is as good as missing", CatalogueTimings.exitConfirmMs(json("""{"constants":{"MOBILE_BACK":{"exitConfirmMs":0}}}""")))
        assertNull("No catalogue loaded yet is not a stale pack", CatalogueTimings.compatibilityNotice(null))
    }
    @Test fun `the double-back exit arms and fires only inside the catalogue window and is unavailable without one`() {
        assertEquals(HomeBackAction.ARM, homeBackAction(nowMs = 10_000, armedAtMs = 0, exitConfirmMs = 2_000))
        assertEquals(HomeBackAction.EXIT, homeBackAction(nowMs = 11_500, armedAtMs = 10_000, exitConfirmMs = 2_000))
        assertEquals(HomeBackAction.EXIT, homeBackAction(nowMs = 12_000, armedAtMs = 10_000, exitConfirmMs = 2_000))
        assertEquals(HomeBackAction.ARM, homeBackAction(nowMs = 12_001, armedAtMs = 10_000, exitConfirmMs = 2_000))
        assertEquals("Without MOBILE_BACK no window is invented: Back cannot exit", HomeBackAction.UNAVAILABLE, homeBackAction(nowMs = 11_500, armedAtMs = 10_000, exitConfirmMs = null))
    }
}
