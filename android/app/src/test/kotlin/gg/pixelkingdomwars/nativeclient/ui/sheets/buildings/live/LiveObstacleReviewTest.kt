package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.model.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LiveObstacleReviewTest {
    private val catalogue = Json.parseToJsonElement("""{"constants":{"OBSTACLES":{"clearRewardShards":7,
        "tiers":{"small":{"kinds":["rock"],"costKeep":25,"clearSec":30,"sizeTiles":1}}}}}""").jsonObject
    private val obstacle = Obstacle("rock-a", "rock", 2, 3)
    private fun state(free: Int = 1, shards: String = "100", jobs: String = "[]") = KingdomUiState(catalogue = catalogue,
        home = BaseState(balances = Balances(shards, "900"), base = BaseSnapshot.from(Json.parseToJsonElement("""{
        "baseId":"base","player":{"keepLevel":3,"builders":2},"freeBuilders":$free,
        "obstacles":[{"id":"rock-a","spriteKey":"rock","tx":2,"ty":3}],"jobs":$jobs}""").jsonObject)))
    private fun ui(s: KingdomUiState = state(), busy: Boolean = false, scene: BaseScene? = null, sent: Boolean = false) =
        requireNotNull(liveObstacleReview(s, obstacle, busy, scene, sent))

    @Test fun `clear price timer reward and builder count come from existing facts`() {
        val ui = ui()
        assertEquals(Currency.SHARDS, ui.price.currency); assertEquals("25", ui.price.amount)
        assertEquals("30s", ui.time); assertEquals("1/2 free", ui.builders)
        assertEquals("Gives 7 Shards once", ui.reward)
        assertEquals(UpgradeState.READY, ui.state)
    }
    @Test fun `missing catalogue cannot create price timer or reward`() {
        val ui = ui(state().copy(catalogue = null))
        assertNull(ui.price.amount); assertNull(ui.reward); assertEquals("…", ui.time)
        assertEquals(PriceStatus.UNAVAILABLE, ui.price.status)
        assertFalse(quoteLook(ui.state, ui.price, ui.reason).sends)
    }
    @Test fun `actual server zero builders opens the builder door`() {
        assertEquals(UpgradeState.NO_BUILDER, ui(state(free = 0)).state)
        assertFalse(quoteLook(ui(state(free = 0)).state, ui().price, null).sends)
    }
    @Test fun `short Shards stays short even with abundant KEEP`() {
        val ui = ui(state(shards = "20"))
        assertEquals(UpgradeState.SHORT, ui.state); assertEquals("5", ui.shortfall)
        assertEquals(PriceStatus.SHORT, ui.price.status)
    }
    @Test fun `busy permissions and saved construction cannot start another clear`() {
        // 02aedc7d M2: BUSY means this sheet sent; ordinary polling must never claim a clear is starting.
        assertEquals(UpgradeState.BUSY, ui(busy = true, sent = true).state)
        val pending = InterruptedIntent(PendingIntent(IntentKind.CONSTRUCTION, "test-wallet", "base", "saved-clear-key",
            "/base/obstacles/rock-a/clear", JsonObject(emptyMap()), "Clear obstacle"))
        for (s in listOf(state().copy(ordersAllowed = false), state().copy(deedActionsAllowed = false), state().copy(interrupted = listOf(pending)))) {
            assertEquals(UpgradeState.READ_ONLY, ui(s).state)
            assertFalse(quoteLook(ui(s).state, ui(s).price, ui(s).reason).sends)
        }
    }
    @Test fun `an existing clearing job keeps its original running-job surface`() {
        assertNull(liveObstacleReview(state(jobs = """[{"id":"job","kind":"clear_obstacle","obstacleId":"rock-a"}]"""), obstacle, false, null))
    }
    @Test fun `portrait only borrows the matching current scene obstacle`() {
        val scene = BaseScene(emptyList(), 10, 10, 16f, baseId = "base",
            obstacles = listOf(RenderObstacle("rock-a", "admitted-rock-frame", 2f, 3f, 1f, 1f, "rock")))
        assertEquals("admitted-rock-frame", ui(scene = scene).sprite)
        assertEquals("shape:unknown", ui(scene = scene.copy(baseId = "other")).sprite)
        assertEquals("shape:unknown", ui().sprite)
    }
    @Test fun `world tap preserves owner priority and busy clear blocks tap-through`() {
        var closed = 0
        assertTrue(consumeObstacleTap(true, false, { true }, { closed++ })); assertEquals(0, closed)
        assertTrue(consumeObstacleTap(true, true, { false }, { closed++ })); assertEquals(0, closed)
        assertTrue(consumeObstacleTap(true, false, { false }, { closed++ })); assertEquals(1, closed)
        assertFalse(consumeObstacleTap(false, false, { false }, { closed++ }))
    }

    @Test fun `a base without freeBuilders cannot invent a free worker`() {
        val s = state(); val base = requireNotNull(s.base)
        val missing = s.copy(home = s.home.copy(base = BaseSnapshot.from(JsonObject(base.raw - "freeBuilders"))))
        val ui = ui(missing)
        assertEquals(UpgradeState.READ_ONLY, ui.state); assertEquals("Builder availability unavailable", ui.reason)
        assertFalse(quoteLook(ui.state, ui.price, ui.reason).sends)
    }
    @Test fun `missing or noninteger Shards cannot start clearing`() {
        val s = state()
        for (candidate in listOf(s.copy(home = s.home.copy(balances = null)), state(shards = "1.5"), state(shards = "broken"))) {
            val ui = ui(candidate)
            assertEquals(UpgradeState.READ_ONLY, ui.state); assertEquals("Shards balance unavailable", ui.reason)
            assertFalse(quoteLook(ui.state, ui.price, ui.reason).sends)
        }
    }
    @Test fun `a refresh waits visibly without pretending this sheet submitted or holding close`() {
        val ui = ui(busy = true)
        assertEquals(UpgradeState.READ_ONLY, ui.state); assertEquals("Your kingdom is updating. Try again in a moment.", ui.reason)
        assertFalse(quoteLook(ui.state, ui.price, ui.reason).sends)
        var closed = false
        assertTrue(consumeObstacleTap(true, false, { false }, { closed = true })); assertTrue(closed)
    }
    @Test fun `camera bounds and tap hold belong to the displayed obstacle sheet and its own send`() {
        // The empty legacy column must not overwrite the live sheet camera rect during an idle selection.
        val screen = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/kingdom/KingdomScreen.kt").readText()
        assertTrue(screen.contains("sheetModifier = sheetBounds, sent = obstacleSent, onSent = { obstacleSent = true }"))
        assertTrue(screen.contains("consumeObstacleTap(obstacleQuoteOpen, busy && obstacleSent,"))
        assertTrue(screen.contains("legacySheetOpen || runningObstacleOpen) 2f else 0f"))
        val host = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/buildings/live/LiveObstacleHost.kt").readText()
        assertTrue(host.contains("then(sheetModifier).verticalScroll"))
        assertTrue(host.contains("if (!busy || !sent) onClose()"))
        assertTrue(host.contains("onSent(); onRemove()"))
    }
}
