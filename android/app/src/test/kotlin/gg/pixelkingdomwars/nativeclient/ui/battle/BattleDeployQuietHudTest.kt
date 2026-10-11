package gg.pixelkingdomwars.nativeclient.ui.battle

import gg.pixelkingdomwars.nativeclient.data.StagingReservationStatus
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.renderer.CameraInsets
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger

/** Owner 2026-09-18: "when you deploy troops on a raid, text is still displayed on the battle scene… when deploying
 * fast it does not look professional and causes HUD or camera jumps". The rule these tests pin: a rapid run of
 * successful deploy taps changes NO text on the battle screen after the first tap retires the prompt, and cannot
 * change the insets the camera was framed against. The coordinator, its journal gate and its publish order are the
 * real ones; only the transport is a fake. */
class BattleDeployQuietHudTest {
    private val raid = "11111111-1111-4111-8111-111111111111"
    private val clock = buildJsonObject {
        put("protocolVersion", 2); put("revision", 0); put("rate", 1); put("anchorWallAt", JsonNull); put("anchorSimMs", 0)
        put("serverNow", "2026-09-01T00:00:00Z"); put("simNowMs", 0); put("battleEndsAt", JsonNull); put("durationMs", 180000)
    }
    private fun staging(troops: Int) = buildJsonObject {
        put("raidId", raid); put("simVersion", 14); put("raidProtocolVersion", 2); put("source", "live"); put("status", "pending_orders")
        put("commands", JsonArray(emptyList())); put("clock", clock); put("_clientFirstPageReceivedAtNanos", 1L)
        put("snapshot", buildJsonObject {}); put("armySnapshot", buildJsonObject { put("counts", buildJsonObject { put("archer", troops) }) })
        put("result", JsonNull)
    }
    /** Everything on the battle screen that a deploy used to touch, built by the screen's own functions. */
    private data class HudText(val hint: String?, val errors: List<String>, val recoveryRows: Int)

    @Test fun `a rapid run of successful deploys changes no battle screen text after the first tap retires the prompt`() = runBlocking {
        val taps = 25
        // A slow journal widens the saved-but-not-yet-sent window exactly as Keystore + fsync do on a device.
        val storage = object : SecretStore { @Volatile var raw: String? = null
            override fun read() = raw; override fun write(value: String) { Thread.sleep(2); raw = value }; override fun clear() { raw = null } }
        val store = PendingBattleStore(storage)
        store.put(PendingBattle("wallet", "deed", raidId = raid, stage = 1))
        val pages = Channel<JsonObject>(Channel.UNLIMITED); pages.send(staging(taps))
        val sequence = AtomicInteger()
        val coordinator = BattleCoordinator.withTransport("wallet", "deed", 14, store, { _, _ -> error("no reads") }, { _, body ->
            delay(5)
            buildJsonObject {
                put("command", JsonObject(requireNotNull(body["command"] as? JsonObject) + mapOf(
                    "clientCommandId" to body.getValue("clientCommandId"), "sequence" to JsonPrimitive(sequence.getAndIncrement()))))
                put("clock", clock)
            }
        }, { pages.receiveAsFlow() })
        val seen = Collections.synchronizedList(mutableListOf<LiveBattleState>())
        val collector = launch(Dispatchers.Unconfined) { coordinator.state.collect { seen += it } }
        val foreground = launch(Dispatchers.Default) { coordinator.runForeground() }
        withTimeout(2_000) { coordinator.state.first { it.phase == BattlePhase.STAGING } }
        val startedAt = System.nanoTime()
        // One coroutine per tap, like BattleRepository.deployAction, so the taps contend for the journal gate.
        (0 until taps).map { tap -> launch(Dispatchers.Default) { coordinator.deploy("archer", tap, 2) } }.joinAll()
        val burstMs = (System.nanoTime() - startedAt) / 1_000_000
        foreground.cancelAndJoin(); collector.cancelAndJoin()
        assertEquals("Every tap was a successful deploy", taps, coordinator.state.value.commands.size)
        assertTrue("The burst must stay far inside the stuck-order delay for this test to mean anything ($burstMs ms)", burstMs < STUCK_BATTLE_REQUEST_MS / 2)

        val committed = BattleHudLatch<Boolean>(); val tracker = BattleStuckRequests()
        val states = seen.toList().filter { it.phase == BattlePhase.STAGING && it.presentation != null }
        val texts = states.mapIndexed { index, live ->
            val summary = battleRecoverySummary(live)
            val nowMs = index.toLong() // far denser than real time: every published state is inspected
            tracker.observe(summary.waiting, nowMs)
            HudText(
                battleHintLine(live, true, StagingReservationStatus.OPEN, nextTargetIntent = false, retreating = false, destroyed = null, field = null,
                    reservesLeft = true, committed = committed.offer(true.takeIf { battleTroopsCommitted(live) }) == true, selection = "ARCHER"),
                battleErrorLines(live, domainError = null, notice = null, createFailed = false), summary.unresolved(tracker.stuck(nowMs)).size)
        }
        assertTrue("The saved-but-not-in-flight window the old row reacted to really occurs in this run",
            states.any { live -> battleRecoverySummary(live).let { it.requests.size - it.sending > 0 } })
        val prompt = HudText("TAP THE FIELD TO DEPLOY · ARCHER", emptyList(), 0); val quiet = HudText("", emptyList(), 0)
        assertEquals("Before the first tap the prompt stands", prompt, texts.first())
        val firstQuiet = texts.indexOf(quiet)
        assertTrue(firstQuiet > 0)
        assertTrue("Only the prompt precedes the first committed troop", texts.take(firstQuiet).all { it == prompt })
        assertEquals("After it, ${taps - 1} more deploys, their journal writes, sends and receipts changed no text at all",
            setOf(quiet), texts.drop(firstQuiet).toSet())
    }

    private val portrait = BattleCameraEnvironment(raid, 1080, 2400, CameraInsets(top = 63, bottom = 63))
    private fun insets(hud: Int, tray: Int) = CameraInsets(top = hud, bottom = tray)
    private fun BattleCameraInsetLatch.resolve(environment: BattleCameraEnvironment, hud: BattleChromeMeasure?, tray: BattleChromeMeasure?) =
        resolve(environment, insets(hud?.pixels ?: 0, tray?.pixels ?: 0), hud, tray)

    /** NativeGameRenderer refits an untouched camera whenever its insets change. The heights fed to it are therefore
     * held after the chrome's first complete measurement: whatever later grows or shrinks the HUD or the tray (a
     * wrapped pill when the clock starts, an error line, a status row) cannot reach the camera. */
    @Test fun `HUD and tray height changes during a battle cannot change the camera insets`() {
        val latch = BattleCameraInsetLatch()
        assertEquals("The scene opens before its chrome exists: the safe area passes through", insets(63, 0),
            latch.resolve(portrait, insets(63, 0), null, null))
        val framed = latch.resolve(portrait, BattleChromeMeasure(318, portrait), BattleChromeMeasure(540, portrait))
        assertEquals("The first complete measurement frames the battlefield", insets(318, 540), framed)
        for ((hud, tray) in listOf(318 to 684, 390 to 684, 318 to 540, 462 to 540, 318 to 0, 0 to 0))
            assertEquals("hud=$hud tray=$tray", framed, latch.resolve(portrait, BattleChromeMeasure(hud, portrait), BattleChromeMeasure(tray, portrait)))
    }

    /** NEXT TARGET, NEXT RAID and NEXT STAGE open the next battlefield in the same screen with the same coordinator,
     * before its chrome is composed. What is still in state then is the finished raid's layout: its result HUD and a
     * tray column emptied down to the navigation inset. Held, that framed the whole next battle as if the troop tray
     * did not exist and left the bottom deploy ring under it, and FIT reused it. Only this raid's own layout may be
     * held; until it reports, the camera follows the measurements as it did before the latch, which corrects itself. */
    @Test fun `A chained raid is framed by its own chrome, never by the finished raid's layout`() {
        val finished = portrait.copy(raidId = "22222222-2222-4222-8222-222222222222")
        val resultHud = BattleChromeMeasure(402, finished); val emptiedTray = BattleChromeMeasure(63, finished)
        val latch = BattleCameraInsetLatch()
        assertEquals("Nothing of this raid is measured yet: the stale heights pass through", insets(402, 63), latch.resolve(portrait, resultHud, emptiedTray))
        assertEquals("One column of this raid is not a complete measurement", insets(318, 63), latch.resolve(portrait, BattleChromeMeasure(318, portrait), emptiedTray))
        val framed = latch.resolve(portrait, BattleChromeMeasure(318, portrait), BattleChromeMeasure(540, portrait))
        assertEquals("The deploy tray of THIS raid frames its battlefield", insets(318, 540), framed)
        assertEquals("and from then on the framing is held", framed, latch.resolve(portrait, BattleChromeMeasure(390, portrait), BattleChromeMeasure(684, portrait)))
    }

    /** MainActivity handles orientation and size changes itself, so the composition and every measured height
     * survive a rotation, a fold or a multi-window resize, and the scene recomposes under the new constraints BEFORE
     * the HUD and tray are remeasured. The first resolve after the change therefore always carries the other
     * orientation's heights; holding those hid the field under the taller portrait chrome or squeezed it into the
     * middle third in landscape, for good. The safe area can arrive a frame after the size, so it re-arms too. */
    @Test fun `A rotation or a new safe area is framed by the chrome measured after it`() {
        val latch = BattleCameraInsetLatch()
        val hud = BattleChromeMeasure(318, portrait); val tray = BattleChromeMeasure(540, portrait)
        assertEquals(insets(318, 540), latch.resolve(portrait, hud, tray))
        val landscape = BattleCameraEnvironment(raid, 2400, 1080, CameraInsets())
        assertEquals("The first composition after the rotation still sees portrait heights: passed through, not held",
            insets(318, 360), latch.resolve(landscape, insets(318, 360), hud, tray))
        assertEquals("The landscape layout pass reports and frames the field", insets(240, 300),
            latch.resolve(landscape, BattleChromeMeasure(240, landscape), BattleChromeMeasure(300, landscape)))
        assertEquals("and is held against later HUD rows", insets(240, 300),
            latch.resolve(landscape, BattleChromeMeasure(280, landscape), BattleChromeMeasure(300, landscape)))
        val cutout = landscape.copy(safe = CameraInsets(left = 96))
        assertEquals("The cutout inset lands a frame later: heights measured without it are not this safe area's",
            CameraInsets(left = 96, top = 280, bottom = 300), latch.resolve(cutout, CameraInsets(left = 96, top = 280, bottom = 300), BattleChromeMeasure(280, landscape), BattleChromeMeasure(300, landscape)))
        assertEquals(CameraInsets(left = 96, top = 252, bottom = 300),
            latch.resolve(cutout, CameraInsets(left = 96, top = 252, bottom = 300), BattleChromeMeasure(252, cutout), BattleChromeMeasure(300, cutout)))
        val landscapeHud = BattleChromeMeasure(252, cutout); val landscapeTray = BattleChromeMeasure(300, cutout)
        assertEquals("Rotating back starts from the landscape heights and holds neither them nor the earlier portrait framing",
            insets(252, 300), latch.resolve(portrait, landscapeHud, landscapeTray))
        assertEquals(insets(330, 540), latch.resolve(portrait, BattleChromeMeasure(330, portrait), BattleChromeMeasure(540, portrait)))
        assertEquals(insets(330, 540), latch.resolve(portrait, BattleChromeMeasure(402, portrait), BattleChromeMeasure(540, portrait)))
    }
}
