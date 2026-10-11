package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.ReviewedBuilderFinishSpend
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.WallRowQuote
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * MS-C3 mount contract §1 (KingdomMountHooks.kt). Why it matters: C3 admits typed Home routes only while this screen says
 * no private review is open. A false "clear" lets a sheet or a navigation land on top of a KEEP spend, a cancel refund,
 * a hero recruitment, a builder payment, a wall-row purchase, a placement or a daily-cache / expansion dialog, so each
 * category must block on its own, and the unknown, paused, disposed and replaced states must block too, while an
 * ordinary selection must not (it holds the doors players navigate by). A scene tap that closes a Half sheet must not
 * also select, run a primary command, place or edit the layout.
 */
class KingdomMountHooksTest {
    private val home = BaseState(base = BaseSnapshot.from(Json.parseToJsonElement(
        """{"baseId":"base-1","player":{"keepLevel":5},"buildings":[],"jobs":[]}""").jsonObject))
    private val loaded = KingdomUiState(home = home)
    private val dialog = PlacementDraft("cannon", 4 to 5)
    private val quote = WallRowQuote(null, "wall-1", "a".repeat(64), 5, emptyList(), "120", "500", true, JsonObject(emptyMap()))
    private val finish = ReviewedBuilderFinishSpend(PendingIntent(kind = IntentKind.CONSTRUCTION, wallet = "wallet-1", baseId = "base-1",
        idempotencyKey = "finish-key-0001", path = "/base/jobs/job-1/speedup", body = JsonObject(emptyMap()), label = "Finish builder job"), 0, 0)
    private fun blocked(state: KingdomUiState = loaded, confirmation: Boolean = false, hero: Boolean = false, live: Boolean = false) =
        kingdomReviewBlocked(state, confirmation, hero, live)
    private fun local(value: KingdomLocal) = loaded.copy(local = value)
    private fun recorder() = mutableListOf<Boolean>().let { seen -> seen to ReviewBlockedLease { seen += it } }

    @Test fun `each private review category blocks on its own`() {
        assertFalse("nothing open is clear", blocked())
        assertTrue("the private KEEP-spend / cancel-job confirmation", blocked(confirmation = true))
        assertTrue("the hero recruitment review", blocked(hero = true))
        assertTrue("the builder finish payment review", blocked(loaded.copy(home = home.copy(builderFinishReview = finish))))
        assertTrue("the wall row purchase quote", blocked(local(KingdomLocal(wallRowQuote = quote))))
        assertTrue("the legacy placement dialog", blocked(local(KingdomLocal(placement = dialog))))
        assertTrue("the daily cache sheet", blocked(local(KingdomLocal(sheet = KingdomSheet.DAILY_CACHE))))
        assertTrue("the expansion sheet", blocked(local(KingdomLocal(sheet = KingdomSheet.EXPAND))))
    }

    @Test fun `the placement blocker is exactly the dialog's own predicate, not a placement selection`() {
        assertTrue(legacyPlacementDialogVisible(dialog, baseLoaded = true, heroReview = false, livePlacement = false))
        assertFalse("no tile yet: still choosing a spot", legacyPlacementDialogVisible(dialog.copy(tile = null), true, false, false))
        assertFalse("walls are drawn, never confirmed in this dialog", legacyPlacementDialogVisible(PlacementDraft("wall", 4 to 5), true, false, false))
        assertFalse("no base loaded", legacyPlacementDialogVisible(dialog, false, false, false))
        assertFalse("the hero review replaces it", legacyPlacementDialogVisible(dialog, true, true, false))
        assertFalse("the live placement host replaces it", legacyPlacementDialogVisible(dialog, true, false, true))
        assertFalse(legacyPlacementDialogVisible(null, true, false, false))
        assertFalse("a tile-less placement is ordinary placement", blocked(local(KingdomLocal(placement = dialog.copy(tile = null)))))
        assertFalse("live placement is admitted separately", blocked(local(KingdomLocal(placement = dialog)), live = true))
        assertFalse("no base, no dialog", blocked(KingdomUiState(local = KingdomLocal(placement = dialog))))
    }

    @Test fun `ordinary selections, the build tray and building doors never block`() {
        listOf(KingdomLocal(selectedBuildingId = "b1"), KingdomLocal(selectedObstacleId = "o1"), KingdomLocal(selectedJobId = "j1"),
            KingdomLocal(buildMenu = true), KingdomLocal(buildMenu = true, heroesOnly = true), KingdomLocal(selectedBuildingId = "w1", wallRow = true),
            KingdomLocal(placement = PlacementDraft("wall", 1 to 1)), KingdomLocal(selectedBuildingId = "b1", infoOpen = true))
            .forEach { assertFalse("$it", blocked(local(it))) }
    }

    @Test fun `overlapping reviews stay blocked until the last one closes, and the lease never reports clear between them`() {
        val both = local(KingdomLocal(sheet = KingdomSheet.EXPAND, wallRowQuote = quote))
        assertTrue(blocked(both, confirmation = true))
        assertTrue("the confirmation closed, two remain", blocked(both))
        assertTrue("the quote closed, the expansion remains", blocked(both.copy(local = both.local.copy(wallRowQuote = null))))
        assertFalse(blocked(both.copy(local = KingdomLocal())))
        val (seen, lease) = recorder()
        lease.mount(); lease.resume()
        listOf(true, true, true, false).forEach(lease::publish)
        assertEquals(listOf(true, false), seen)
    }

    @Test fun `the lease is blocked at mount, while unknown, while paused, and resume recomputes`() {
        val (seen, lease) = recorder()
        lease.mount()
        assertEquals(listOf(true), seen)
        lease.resume()
        assertEquals("nothing published yet is unknown, still blocked", listOf(true), seen)
        lease.publish(false)
        assertEquals(listOf(true, false), seen)
        lease.pause()
        assertEquals(listOf(true, false, true), seen)
        lease.publish(false)
        assertEquals("a paused owner never reports clear", listOf(true, false, true), seen)
        lease.resume()
        assertEquals("resume recomputes from the committed aggregate", listOf(true, false, true, false), seen)
    }

    @Test fun `a mount composed before resume reports clear only once it resumes`() {
        val (seen, lease) = recorder()
        lease.mount(); lease.publish(false)
        assertEquals(listOf(true), seen)
        lease.resume()
        assertEquals(listOf(true, false), seen)
    }

    @Test fun `a private confirmation is reported blocked before it opens`() {
        val (seen, lease) = recorder()
        lease.mount(); lease.resume(); lease.publish(false)
        lease.opening()
        assertEquals(listOf(true, false, true), seen)
        lease.publish(true)
        assertEquals("the composed confirmation repeats nothing", listOf(true, false, true), seen)
        lease.publish(false)
        assertEquals(listOf(true, false, true, false), seen)
    }

    @Test fun `disposal and replacement block through the retired callback, which can never release the new owner`() {
        val (old, first) = recorder()
        first.mount(); first.resume(); first.publish(false)
        // Replacement, as KingdomScreen's DisposableEffect runs it: the old registration retires, then the new one mounts.
        first.retire()
        val (new, second) = recorder()
        second.mount(); second.resume()
        assertEquals(listOf(true, false, true), old)
        assertEquals(listOf(true), new)
        first.publish(false); first.resume(); first.opening(); first.pause(); first.retire()
        assertEquals("a late composition or event through the retired lease reaches nobody", listOf(true, false, true), old)
        assertEquals(listOf(true), new)
        second.publish(false)
        assertEquals(listOf(true, false), new)
        second.retire()
        assertEquals("disposal blocks through the callback it was registered with", listOf(true, false, true), new)
    }

    @Test fun `a consumed scene tap asks the hook first and leaves nothing for the same tap to select`() {
        // The renderer reports one tap on a building as ground, then footprint (dispatchSceneTap).
        val claim = ArmyChipTapClaim()
        var asks = 0
        claim.down("camp-1")
        assertTrue(sceneTapConsumed({ asks++; true }, claim))
        assertNull("the chip under the finger is dropped", claim.takeDownChip())
        // Even when the owner's exit is already over as the footprint arrives, that same tap selects nothing.
        assertFalse(sceneTapConsumed({ asks++; false }, claim))
        assertFalse("the same tap's footprint is refused", claim.allowFootprint())
        assertEquals("asked once per callback, first", 2, asks)
        claim.down(null)
        assertTrue("the next gesture starts clean", claim.allowFootprint())
    }

    @Test fun `an unconsumed scene tap leaves the chip bookkeeping exactly as before`() {
        val claim = ArmyChipTapClaim()
        claim.down("camp-1")
        assertFalse(sceneTapConsumed({ false }, claim))
        assertEquals("camp-1", claim.takeDownChip())
        claim.ground("camp-1")
        assertFalse("the chip claimed the tap: the building underneath does not replace it", claim.allowFootprint())
    }

    // Composables do not run on the JVM; this pins the wiring the rules above depend on.
    @Test fun `KingdomScreen asks the tap hook first in both resolved callbacks, never on a pointer-down, and publishes the aggregate`() {
        val screen = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomScreen.kt").readText()
        assertTrue(screen.contains("onSelected = { id -> if (!sceneTapConsumed(latestBeforeSceneTap, chipTap) && chipTap.allowFootprint()"))
        assertTrue(screen.contains("onGround = { x, y -> if (!sceneTapConsumed(latestBeforeSceneTap, chipTap)) {"))
        // Rewritten 2026-10-06 (night UI mount): this pinned exactly 2 calls, but the world layers above the scene (the
        // construction plates since 1822d3c9, the READY / notice bubbles now) are taps on the kingdom too. The rule that
        // matters: every resolved tap path asks the same hook first, with the same chip claim, never some other way.
        val asks = Regex("sceneTapConsumed\\(").findAll(screen).count()
        assertTrue("both resolved scene callbacks ask the hook", asks >= 2)
        assertEquals("every tap path asks the same hook with the same claim", asks,
            Regex("sceneTapConsumed\\(latestBeforeSceneTap, chipTap\\)").findAll(screen).count())
        val down = screen.lines().first { "onSurfaceDown =" in it }
        assertFalse("a pan never dismisses a Half sheet", "sceneTapConsumed" in down || "BeforeSceneTap" in down)
        assertTrue(screen.contains("onReviewBlockedChanged: (Boolean) -> Unit = {},"))
        assertTrue(screen.contains("onBeforeSceneTap: () -> Boolean = { false },"))
        assertTrue("both hooks precede the trailing dock parameter",
            screen.indexOf("onBeforeSceneTap: () -> Boolean") < screen.indexOf("dock: @Composable RowScope.() -> Unit"))
        assertTrue(screen.contains("remember(onReviewBlockedChanged, lifecycle) { ReviewBlockedLease(onReviewBlockedChanged) }"))
        assertTrue(screen.contains("onDispose { lifecycle.removeObserver(observer); reviewLease.retire() }"))
        assertTrue(screen.contains("SideEffect { reviewLease.publish(reviewBlocked) }"))
        assertEquals("both private confirmations report blocked before they open", 2, Regex("reviewLease\\.opening\\(\\)").findAll(screen).count())
        // Rewritten 2026-10-06 (owner Seeker 16:45, "The altar review closed"): the hero argument is now heroReviewHeld, the
        // review OR its confirm in flight, so the tile dialog is not redrawn under the player's tap while the consumed review's
        // request is sent. The rule pinned here is unchanged: the dialog and the review signal read the same predicate and inputs.
        assertTrue("the dialog renders from the predicate the signal reads",
            screen.contains("if (legacyPlacementDialogVisible(draft, base != null, heroReviewHeld(heroState), livePlacement != null)"))
        assertTrue(screen.contains("kingdomReviewBlocked(state, confirmation != null, heroReviewHeld(heroState), livePlacement != null,"))
    }
}
