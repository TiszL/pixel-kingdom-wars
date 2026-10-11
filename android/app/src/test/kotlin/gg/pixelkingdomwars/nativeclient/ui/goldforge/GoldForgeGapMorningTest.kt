package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.GemsReview
import gg.pixelkingdomwars.nativeclient.data.GemsState
import gg.pixelkingdomwars.nativeclient.model.BalanceFeatures
import gg.pixelkingdomwars.nativeclient.model.GemsFeature
import gg.pixelkingdomwars.nativeclient.model.GemsOverview
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.kit.FullScreenSheetGeometry
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ClaimSealUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeSamples
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.HeroStatusKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.HeroStatusUi
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger

/**
 * Morning gap pass on the Gold Forge group (owner 2026-10-06: "always loading", "not even 1 of old screens", "fast and
 * smooth"). These pin why the fixes matter: a re-open never blanks what the forge already showed, CONVERT stays on the
 * designed Seal over its existing owner, the toast zone carries no old-page door on CLAIM or LEGACY, and the "+n" never
 * lands on the GEMS pill of a full-screen sheet's shelf.
 */
class GoldForgeGapMorningTest {
    private val identity = HomeRouteIdentity(Any(), "base-1", 3)
    private val settled = GoldForgeSamples.sheet

    // WHY: the owner saw the forge blank ("Checking the forge…", "…" pills, "Reconnecting") on every open while seven reads
    // ran; the SPEC says a re-open draws the last values and the body never blanks.
    @Test fun `a re-open in flight draws the last settled claim gems level and pills`() {
        val fresh = settled.copy(level = UNKNOWN, heroStatus = HeroStatusUi(HeroStatusKind.RECONNECTING), sceneWorking = false,
            claim = null, gems = null, stack = settled.stack.map { it.copy(value = UNKNOWN) })
        val shown = goldForgeKeptSheet(fresh, settled, reading = true)
        assertEquals("LV 3", shown.level)
        assertEquals(HeroStatusKind.FORGING, shown.heroStatus.kind)
        assertTrue(shown.sceneWorking)
        assertSame(settled.claim, shown.claim)
        assertSame(settled.gems, shown.gems)
        assertEquals(settled.stack.map { it.value }, shown.stack.map { it.value })
    }

    // WHY: a kept value is a stand-in only while reading; a settled read that legitimately has no body (an unavailable
    // mint) must show its own notice, never an old tray.
    @Test fun `a settled pass is never covered by kept values`() {
        val fresh = settled.copy(claim = null, level = UNKNOWN)
        val shown = goldForgeKeptSheet(fresh, settled, reading = false)
        assertNull(shown.claim)
        assertEquals(UNKNOWN, shown.level)
        assertSame(fresh, goldForgeKeptSheet(fresh, null, reading = true))
    }

    // WHY: fresh values always win over kept ones, even mid-read.
    @Test fun `fresh values win over kept ones while reading`() {
        val fresh = settled.copy(level = "LV 4", claim = GoldForgeSamples.claimReady.copy(ready = "9"))
        val shown = goldForgeKeptSheet(fresh, settled, reading = true)
        assertEquals("LV 4", shown.level)
        assertEquals("9", shown.claim?.ready)
    }

    // WHY: a kept face must never re-raise a Seal (consent belongs to the exact review on screen) nor keep another
    // kingdom's values.
    @Test fun `memory keeps no Seal and only for the same kingdom generation`() {
        val memory = GoldForgeHomeMemory()
        memory.keep(identity, settled.copy(claim = GoldForgeSamples.claimReady.copy(seal = ClaimSealUi("1,240", 0L))))
        val kept = memory.sheetFor(identity)
        assertNull(kept?.claim?.seal)
        assertNull(kept?.smelt)
        assertNull(memory.sheetFor(identity.copy(baseSelectionGeneration = 4)))
        assertNull(memory.sheetFor(HomeRouteIdentity(Any(), "base-1", 3)))
    }

    // WHY: the hero art is decoded once per content generation; a failed decode must be retried, and another manifest
    // object (a content update) must never reuse old bitmaps.
    @Test fun `the foundry decode is reused only for the same complete content generation`() {
        val memory = GoldForgeHomeMemory()
        val root = java.io.File("content-root")
        val manifest = Any()
        memory.keepScene(root, manifest, true, emptyMap<String, androidx.compose.ui.graphics.ImageBitmap>() to true)
        assertNull(memory.sceneFor(root, manifest, true))
        assertNull(memory.sceneFor(root, Any(), true))
        assertNull(memory.sceneFor(null, manifest, true))
    }

    private fun overview(gems: String = "40", rate: Long = 17) = GemsOverview(BalanceFeatures(GemsFeature(1, 1)), gems, emptyList(),
        emptyList(), minConvertKeep = 3, maxConvertKeepPerTx = 91, gemsPerKeep = 1, shardsPerGem = rate,
        serverNow = "2026-10-06T07:00:00.000Z")
    private fun intent(kind: String = IntentKind.GEMS_TO_SHARDS) = PendingIntent(kind, "wallet-1", "base-1", "original-key-1",
        "/gems/to-shards", buildJsonObject { put("gems", "5") }, "Gems to SHARDS")

    // WHY: CONVERT must work in place over the existing owner: it previews with the server rate, and the reviewed output is
    // the owner's own (never a client sum) once the review is up.
    @Test fun `convert previews with the server rate then shows the owner's reviewed output`() {
        val choose = goldForgeConvertFace(GemsState(supported = true, enabled = true, overview = overview()), false, "3")
        assertEquals(GoldForgeConvertStage.CHOOSE, choose.stage)
        assertEquals("51", choose.shards)
        assertTrue(choose.amountOk)
        val reviewed = GemsState(supported = true, enabled = false, overview = overview(),
            review = GemsReview(intent(), 17, "85", 3, 1))
        val review = goldForgeConvertFace(reviewed, false, "3")
        assertEquals(GoldForgeConvertStage.REVIEW, review.stage)
        assertEquals("5", review.gems)
        assertEquals("85", review.shards)
    }

    // WHY: one Gems request at a time: a saved original is checked or retried before anything new, and a busy owner shows
    // its busy face instead of accepting taps.
    @Test fun `a saved original or a busy owner comes before a new conversion`() {
        val saved = goldForgeConvertFace(GemsState(overview = overview(), pending = listOf(intent())), false, "3")
        assertEquals(GoldForgeConvertStage.SAVED, saved.stage)
        assertEquals(IntentKind.GEMS_TO_SHARDS, saved.savedKind)
        assertFalse(saved.savedReceipt)
        assertEquals(GoldForgeConvertStage.BUSY, goldForgeConvertFace(GemsState(busy = true, overview = overview()), false, "3").stage)
        assertEquals(GoldForgeConvertStage.BUSY, goldForgeConvertFace(GemsState(overview = overview()), true, "3").stage)
        val off = goldForgeConvertFace(GemsState(unavailable = "Gems are unavailable."), false, "3")
        assertEquals(GoldForgeConvertStage.OFF, off.stage)
        assertEquals("Gems are unavailable.", off.offReason)
    }

    // WHY: the player can never pick more Gems than they have, nor zero; a short amount turns the primary off with a reason.
    @Test fun `the amount stays within what the player has`() {
        val have = BigInteger.valueOf(40)
        assertEquals("40", goldForgeConvertStep("40", 1, have))
        assertEquals("1", goldForgeConvertStep("1", -1, have))
        assertEquals("7", goldForgeConvertStep("7", 0, null))
        assertEquals("10", goldForgeConvertPick("¼", have))
        assertEquals("20", goldForgeConvertPick("½", have))
        assertEquals("40", goldForgeConvertPick("MAX", have))
        assertEquals("1", goldForgeConvertPick("¼", BigInteger.ONE))
        assertNull(goldForgeConvertPick("MAX", BigInteger.ZERO))
        assertFalse(goldForgeConvertFace(GemsState(overview = overview()), false, "41").amountOk)
        assertFalse(goldForgeConvertFace(GemsState(overview = overview()), false, "0").amountOk)
    }

    // WHY: on a phone the forge's GEMS and KEEP pills share one shelf row; the "+n" must sit left of both, never on GEMS.
    @Test fun `the gain rises left of the two shelf pills`() {
        for (width in listOf(360f, 412f, 457f)) {
            val pill = FullScreenSheetGeometry.pillWidthDp(2, width)
            val pillsEdge = FullScreenSheetGeometry.GUTTER_DP + 2f * pill + FullScreenSheetGeometry.PILL_GAP_DP
            assertTrue("$width", goldForgeShelfGainEndDp(width) > pillsEdge)
        }
    }

    private fun source(path: String) = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()

    // WHY: the owner's rule "not even 1 of old screens": CONVERT no longer navigates to the old GEMS WALLET page, and the
    // toast zone carries no old-page door on CLAIM (it explains in place) or LEGACY (recovery stays in its own list).
    @Test fun `CONVERT and the CLAIM and LEGACY tabs keep the player on the designed forge`() {
        val app = source("ui/nav/PkwApp.kt")
        assertTrue(app.contains("onConvert = forgeConvert?.open,"))
        assertFalse(app.contains("onConvert = { handoff { navController.navigate(GemsRoute)"))
        assertTrue(app.contains("forgeConvert?.overlay?.invoke()"))
        val mount = source("ui/goldforge/GoldForgeHomeMount.kt")
        assertTrue(mount.contains("sheetUi.selectedTab == GoldForgeTabs.CLAIM || sheetUi.selectedTab == GoldForgeTabs.LEGACY -> null"))
        val binding = source("ui/goldforge/GoldForgeGemsBinding.kt")
        assertTrue(binding.contains("GoldForgeCelebration(goldForgeGemsCelebrationUi(shown), ForgeCelebrationKind.GEMS"))
    }
}
