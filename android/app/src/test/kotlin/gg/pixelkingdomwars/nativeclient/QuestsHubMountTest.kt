package gg.pixelkingdomwars.nativeclient

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.data.BaseRepository
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.Quest
import gg.pixelkingdomwars.nativeclient.model.QuestBoard
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureRegistry
import gg.pixelkingdomwars.nativeclient.ui.features.GateContext
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteContext
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteDispatchResult
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteDispatcher
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.home.HomeSheetRouteHost
import gg.pixelkingdomwars.nativeclient.ui.home.HomeTab
import gg.pixelkingdomwars.nativeclient.ui.home.homeHudState
import gg.pixelkingdomwars.nativeclient.ui.home.mountedHomeSheetFrame
import gg.pixelkingdomwars.nativeclient.ui.hud.HOME_HUD_BUDGET
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.hud.coveredFraction
import gg.pixelkingdomwars.nativeclient.ui.hud.homeHudPlan
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.EdgeButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.more.QuestsActionGate
import gg.pixelkingdomwars.nativeclient.ui.more.QuestsScope
import gg.pixelkingdomwars.nativeclient.ui.more.QuestsViewModel
import gg.pixelkingdomwars.nativeclient.ui.more.currentClaimableQuest
import gg.pixelkingdomwars.nativeclient.ui.more.questsScopeCurrent
import gg.pixelkingdomwars.nativeclient.ui.more.retainedQuestsBoard
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Tests-first B2 contracts under d56ed10d and 3730fba8. Authored only; Cedar3 owns execution. */
@OptIn(ExperimentalCoroutinesApi::class)
class QuestsHubMountTest {
    private data class SessionLabel(val wallet: String)
    private val models = mutableListOf<QuestsViewModel>()

    @Before fun mainDispatcher() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun releaseModels() {
        models.forEach { it.viewModelScope.cancel() }
        Dispatchers.resetMain()
    }

    @Test fun `quest scope requires the exact session reference and rejects an absent owner`() {
        val session = SessionLabel("same-wallet")
        val replacement = SessionLabel("same-wallet")
        val expected = QuestsScope(session, "base-a", 4)

        assertEquals(session, replacement)
        assertTrue(questsScopeCurrent(expected, QuestsScope(session, "base-a", 4)))
        assertFalse(questsScopeCurrent(expected, QuestsScope(replacement, "base-a", 4)))
        assertFalse(questsScopeCurrent(expected, null))
    }

    @Test fun `quest scope cannot revive after base A to B to A or a changed selection generation`() {
        val session = Any()
        val expected = QuestsScope(session, "base-a", 4)

        assertFalse(questsScopeCurrent(expected, QuestsScope(session, "base-b", 5)))
        assertFalse(questsScopeCurrent(expected, QuestsScope(session, "base-a", 6)))
        assertFalse(questsScopeCurrent(expected, QuestsScope(session, "base-a", 5)))
        assertFalse(questsScopeCurrent(expected, QuestsScope(session, null, 4)))
        val unselected = QuestsScope(session, null, 4)
        assertTrue(questsScopeCurrent(unselected, QuestsScope(session, null, 4)))
        assertFalse(questsScopeCurrent(unselected, expected))
    }

    // Owner 2026-10-06 "always loading": the Quests sheet drew skeleton rows on every open while it re-read the board.
    @Test fun `a reopened Quests sheet starts on its own last accepted board only for the same owner`() {
        val session = Any()
        val owner = QuestsScope(session, "base-a", 4)
        val shown = BaseState(quests = QuestBoard(quests = listOf(Quest(id = "q-1", templateCode = "first_camp", completed = true))))
        val last = owner to shown

        assertSame("The same owner reopens on the board it last accepted", shown, retainedQuestsBoard(QuestsScope(session, "base-a", 4), last))
        assertNull("Nothing was accepted yet", retainedQuestsBoard(owner, null))
        assertNull("Another kingdom never shows this board", retainedQuestsBoard(QuestsScope(session, "base-b", 4), last))
        assertNull("A to B to A advances the generation and never revives it", retainedQuestsBoard(QuestsScope(session, "base-a", 6), last))
        assertNull("A replaced session never revives it", retainedQuestsBoard(QuestsScope(Any(), "base-a", 4), last))
        val model = QuestsViewModel(FakeBaseRepository(), FakeContentRepository()).also { models += it }
        assertNull("A new sheet owner starts with nothing retained", model.lastAccepted)
    }

    @Test fun `a current unblocked quest action forwards exactly once without a refusal`() {
        val expected = QuestsScope(Any(), "base-a", 4)
        val reasons = mutableListOf<String>()
        val gate = QuestsActionGate(expected, { expected }, { false }, { null }, { reasons += it })
        var calls = 0

        assertTrue(gate.run { calls++ })
        assertEquals(1, calls)
        assertTrue(reasons.isEmpty())
    }

    @Test fun `stale quest actions have no effect and always explain their refusal`() {
        val session = SessionLabel("same-wallet")
        val expected = QuestsScope(session, "base-a", 4)
        for (actual in listOf(null, QuestsScope(SessionLabel("same-wallet"), "base-a", 4),
            QuestsScope(session, "base-b", 5), QuestsScope(session, "base-a", 6))) {
            val reasons = mutableListOf<String>()
            val gate = QuestsActionGate(expected, { actual }, { false }, { null }, { reasons += it })
            var calls = 0

            assertFalse(gate.run { calls++ })
            assertEquals(0, calls)
            assertEquals(1, reasons.size)
            assertTrue(reasons.single().isNotBlank())
        }
    }

    @Test fun `quest action admission reads current busy and error state on every tap`() {
        val expected = QuestsScope(Any(), "base-a", 4)
        var busy = true
        var error: String? = null
        var calls = 0
        val reasons = mutableListOf<String>()
        val gate = QuestsActionGate(expected, { expected }, { busy }, { error }, { reasons += it })

        assertFalse(gate.run { calls++ })
        busy = false
        error = "The quest board could not be read. Refresh quests."
        assertFalse(gate.run { calls++ })
        assertEquals(0, calls)
        assertEquals(2, reasons.size)
        assertTrue(reasons.all { it.isNotBlank() })
        error = null
        assertTrue(gate.run { calls++ })
        assertEquals(1, calls)
        assertEquals(2, reasons.size)
    }

    @Test fun `an ongoing quest operation remains current while its own busy or read error state changes`() {
        val expected = QuestsScope(Any(), "base-a", 4)
        val reasons = mutableListOf<String>()
        val gate = QuestsActionGate(expected, { expected }, { true }, { "Read failed" }, { reasons += it })

        // Continuation checks ownership only: an operation must not cancel itself when it sets busy.
        gate.requireCurrent()
        assertTrue(reasons.isEmpty())
    }

    @Test fun `quest continuation cancels after owner replacement base switch or generation revival`() {
        val session = SessionLabel("same-wallet")
        val expected = QuestsScope(session, "base-a", 4)
        var current: QuestsScope? = expected
        val gate = QuestsActionGate(expected, { current }, { false }, { null }, {})
        gate.requireCurrent()

        for (actual in listOf(null, QuestsScope(SessionLabel("same-wallet"), "base-a", 4),
            QuestsScope(session, "base-b", 5), QuestsScope(session, "base-a", 6))) {
            current = actual
            expectCancellation { gate.requireCurrent() }
        }
    }

    @Test fun `Quests uses a full frame for DAILY and KINGDOM and refuses unknown restored tabs`() {
        for (tab in listOf("DAILY", "KINGDOM")) {
            val frame = requireNotNull(mountedHomeSheetFrame(SheetEntry(Destination.Quests(tab))))
            assertEquals(SheetSize.FULL, frame.size)
            assertEquals(tab, frame.selectedTab)
            val restored = requireNotNull(mountedHomeSheetFrame(
                SheetEntry(Destination.Quests(), selectedTab = tab, restored = true)))
            assertEquals(SheetSize.FULL, restored.size)
            assertEquals(tab, restored.selectedTab)
        }
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Quests("UNKNOWN"))))
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Quests(), selectedTab = "UNKNOWN")))
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Quests("UNKNOWN"), selectedTab = "DAILY")))
    }

    @Test fun `Quests keeps its standalone fallback without identity or admission and mounts when admitted`() {
        val f = RouteFixture()
        assertTrue(f.host.canOpen(f.feature, HomeTab.KINGDOM))
        assertFalse(f.host.canOpen(f.feature, HomeTab.WORLD))
        assertFalse(f.host.canOpen(f.feature, HomeTab.ARMY))

        // d56ed10d preserves the existing standalone door while Home cannot admit its sheet.
        // A false handled result lets HomeScaffold navigate; it must not silently enqueue or swallow the tap.
        f.current = null
        assertFalse(f.host.canOpen(f.feature, HomeTab.KINGDOM))
        assertFalse(f.tap())
        assertEquals(1, f.standalone)
        assertNull(f.requests.pending.value)
        f.current = f.identity
        f.blocked = true
        f.mount.reportBlocked(true)
        assertFalse(f.host.canOpen(f.feature, HomeTab.KINGDOM))
        assertFalse(f.tap())
        assertEquals(2, f.standalone)
        assertNull(f.requests.pending.value)
        assertTrue(f.opened.isEmpty())
        assertTrue(f.reasons.isEmpty())

        f.blocked = false
        f.mount.reportBlocked(false)
        assertTrue(f.tap())
        val request = f.requests.pending.value as HomeRequest.Open
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertNull(f.requests.pending.value)
        assertEquals(listOf(Destination.Quests()), f.opened)
        assertEquals(2, f.standalone)
        assertTrue(f.reasons.isEmpty())
    }

    @Test fun `queued Quests intents retire after lost identity replacement or A to B to A`() {
        for (replacement in 0..3) {
            val f = RouteFixture()
            assertTrue(f.tap())
            val request = f.requests.pending.value as HomeRequest.Open
            f.current = when (replacement) {
                0 -> null
                1 -> HomeRouteIdentity(Any(), "base-a", 4)
                2 -> HomeRouteIdentity(f.identity.session, "base-b", 5)
                else -> HomeRouteIdentity(f.identity.session, "base-a", 6)
            }

            assertEquals(HomeRouteDispatchResult.STALE, f.dispatcher.consume(request))
            assertNull(f.requests.pending.value)
            assertTrue(f.opened.isEmpty())
            assertEquals(0, f.standalone)
        }
    }

    @Test fun `an admitted Quests request explains deferral and resumes once without a fallback`() {
        val f = RouteFixture()
        assertTrue(f.tap())
        val request = f.requests.pending.value as HomeRequest.Open
        f.blocked = true
        f.mount.reportBlocked(true)

        assertEquals(HomeRouteDispatchResult.DEFERRED, f.dispatcher.consume(request))
        assertEquals(request, f.requests.pending.value)
        assertTrue(f.opened.isEmpty())
        assertEquals(1, f.reasons.size)
        assertTrue(f.reasons.single().isNotBlank())
        assertEquals(0, f.standalone)

        f.blocked = false
        f.mount.reportBlocked(false)
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertNull(f.requests.pending.value)
        assertEquals(listOf(Destination.Quests()), f.opened)
        assertEquals(0, f.standalone)
    }

    @Test fun `the QUESTS door remains available when the board is unknown or has no ready claims`() {
        for (board in listOf(null, QuestBoard(), QuestBoard(quests = listOf(
            Quest(id = "progress", completed = false), Quest(id = "claimed", completed = true, claimed = true))))) {
            val ui = homeHudState(BaseState(quests = board), null, 0, false, 0, 0, false)
            val door = ui.rightEdge.single { it.id == HudIds.QUESTS }
            assertEquals("QUESTS", door.label)
            assertNull(door.badge)
        }
    }

    @Test fun `the QUESTS door badges only completed unclaimed quests`() {
        val board = QuestBoard(quests = listOf(Quest(id = "one", completed = true),
            Quest(id = "two", completed = true), Quest(id = "progress"),
            Quest(id = "claimed", completed = true, claimed = true)))
        val ui = homeHudState(BaseState(quests = board), null, 0, false, 0, 0, false)
        val door = ui.rightEdge.single { it.id == HudIds.QUESTS }
        assertEquals("2", door.badge?.text)
        assertEquals("2 quests ready to claim", door.badge?.description)
    }

    @Test fun `the HUD plan keeps unbadged QUESTS alone while preserving other filters counts and budget folding`() {
        val ui = homeHudState(BaseState(quests = QuestBoard()), null, 0, false, 0, 0, false)
        val resting = homeHudPlan(ui)
        assertEquals(HudIds.QUESTS, resting.rightEdge.single().id)
        assertNull(resting.rightEdge.single().badge)
        assertEquals(0, resting.rightEdgeFolded)

        val hidden = EdgeButtonUi(FeatureId("test.unbadged"), "quest", "HIDDEN", null, false)
        val ready = (1..3).map { count -> EdgeButtonUi(FeatureId("test.ready.$count"), "quest", "READY",
            BadgeUi(count.toString(), BadgeTone.COUNT, "$count ready"), false) }
        val crowded = ui.copy(rightEdge = ui.rightEdge + hidden + ready)
        val actual = homeHudPlan(crowded)
        // Giving QUESTS a badge must change only that badge, never admission counts or the geometry budget.
        val reference = homeHudPlan(crowded.copy(rightEdge = crowded.rightEdge.map {
            if (it.id == HudIds.QUESTS) it.copy(badge = BadgeUi("1", BadgeTone.COUNT, "1 ready")) else it
        }))

        assertEquals(HudIds.QUESTS, actual.rightEdge.first().id)
        assertNull(actual.rightEdge.first().badge)
        assertFalse(actual.rightEdge.any { it.id == hidden.id })
        assertEquals(reference.rightEdge.map { it.id }, actual.rightEdge.map { it.id })
        assertEquals(reference.rightEdge.drop(1), actual.rightEdge.drop(1))
        assertEquals(reference.rightEdgeFolded, actual.rightEdgeFolded)
        assertEquals(4, actual.rightEdge.size + actual.rightEdgeFolded)
        assertEquals(reference.resources, actual.resources)
        assertEquals(reference.leftEdge, actual.leftEdge)
        assertEquals(reference.deck, actual.deck)
        assertEquals(reference.permanentReadouts, actual.permanentReadouts)
        assertTrue(actual.rightEdge.size <= PkwTokens.Budget.MAX_EDGE_BUTTONS)
        assertEquals(coveredFraction(reference), coveredFraction(actual), 0f)
        assertTrue(coveredFraction(actual) <= HOME_HUD_BUDGET)
    }

    @Test fun `single claim checks captured ownership before forwarding exactly once`() = runTest {
        val base = FakeBaseRepository()
        val model = model(base)
        base.calls.clear()
        val expected = QuestsScope(Any(), "base-a", 4)
        var current: QuestsScope? = null
        val gate = QuestsActionGate(expected, { current }, { false }, { null }, {})

        val refused = requireNotNull(model.claim("one", gate::requireCurrent))
        refused.join()
        assertTrue(refused.isCancelled)
        assertTrue(base.calls.isEmpty())
        assertNull(model.notice.value)

        current = expected
        requireNotNull(model.claim("one", gate::requireCurrent)).join()
        assertEquals(listOf("claim:one"), base.calls)
    }

    @Test fun `a single claim requires one identical ready row in the accepted and current boards`() {
        val row = Quest(id = "one", completed = true, rewardShards = "10", target = "3", progress = "3")
        val accepted = QuestBoard(quests = listOf(row))
        val current = QuestBoard(quests = listOf(row.copy(), Quest(id = "unrelated")))
        assertTrue(currentClaimableQuest("one", accepted, current))
        assertFalse(currentClaimableQuest("one", null, current))
        assertFalse(currentClaimableQuest("one", accepted, null))
        assertFalse(currentClaimableQuest("one", QuestBoard(), current))
        assertFalse(currentClaimableQuest("one", accepted, QuestBoard()))
        for (changed in listOf(row.copy(rewardShards = "11"), row.copy(completed = false), row.copy(claimed = true))) {
            assertFalse(currentClaimableQuest("one", accepted, QuestBoard(quests = listOf(changed))))
            assertFalse(currentClaimableQuest("one", QuestBoard(quests = listOf(changed)), current))
            if (!changed.completed || changed.claimed) assertFalse(currentClaimableQuest("one",
                QuestBoard(quests = listOf(changed)), QuestBoard(quests = listOf(changed))))
        }
        val duplicate = QuestBoard(quests = listOf(row, row.copy()))
        assertFalse(currentClaimableQuest("one", duplicate, current))
        assertFalse(currentClaimableQuest("one", accepted, duplicate))
    }

    @Test fun `batch freezes ready IDs and forwards each once while a second tap is refused`() = runTest {
        val base = FakeBaseRepository().also { it._state.value = readyState("one", "two") }
        val firstReply = CompletableDeferred<Unit>()
        val repo = object : BaseRepository by base {
            override suspend fun claimQuest(questId: String) {
                base.claimQuest(questId)
                if (questId == "one") firstReply.await()
            }
        }
        val model = model(repo)
        base.calls.clear()
        val owner = QuestsScope(Any(), "base-a", 4)
        val gate = QuestsActionGate(owner, { owner }, { model.busy.value }, { null }, {})
        val job = requireNotNull(model.claimAll(gate::requireCurrent))
        assertEquals(listOf("claim:one"), base.calls)
        assertNull(model.claimAll(gate::requireCurrent))
        base._state.value = readyState("one", "two", "new-after-tap")
        firstReply.complete(Unit)
        job.join()

        assertFalse(job.isCancelled)
        assertEquals(listOf("claim:one", "claim:two", "quests"), base.calls)
        assertEquals("2 QUESTS CLAIMED", model.notice.value?.message)
    }

    @Test fun `batch stops after an awaited claim when session base or generation changes`() = runTest {
        for (readyCount in 1..2) for (replacement in 0..3) {
            val base = FakeBaseRepository().also {
                it._state.value = if (readyCount == 1) readyState("one") else readyState("one", "two")
            }
            val firstReply = CompletableDeferred<Unit>()
            val repo = object : BaseRepository by base {
                override suspend fun claimQuest(questId: String) {
                    base.claimQuest(questId)
                    firstReply.await()
                }
            }
            val model = model(repo)
            base.calls.clear()
            val expected = QuestsScope(SessionLabel("same-wallet"), "base-a", 4)
            var current: QuestsScope? = expected
            val gate = QuestsActionGate(expected, { current }, { model.busy.value }, { null }, {})
            val job = requireNotNull(model.claimAll(gate::requireCurrent))
            assertEquals(listOf("claim:one"), base.calls)
            current = when (replacement) {
                0 -> null
                1 -> QuestsScope(SessionLabel("same-wallet"), "base-a", 4)
                2 -> QuestsScope(expected.session, "base-b", 5)
                else -> {
                    current = QuestsScope(expected.session, "base-b", 5)
                    QuestsScope(expected.session, "base-a", 6)
                }
            }
            firstReply.complete(Unit)
            job.join()

            assertTrue(job.isCancelled)
            assertEquals(listOf("claim:one"), base.calls)
            assertNull(model.notice.value)
            assertFalse(model.busy.value)
        }
    }

    @Test fun `batch checks ownership at entry even when no quests are ready`() = runTest {
        val base = FakeBaseRepository()
        val model = model(base)
        base.calls.clear()
        var checks = 0
        val job = requireNotNull(model.claimAll { checks++; throw CancellationException("retired") })
        job.join()
        assertEquals(1, checks)
        assertTrue(job.isCancelled)
        assertTrue(base.calls.isEmpty())
        assertNull(model.notice.value)
    }

    @Test fun `an interrupted batch refreshes once and reports only acknowledged claims`() = runTest {
        val base = FakeBaseRepository().also { it._state.value = readyState("one", "two", "three") }
        val repo = object : BaseRepository by base {
            override suspend fun claimQuest(questId: String) {
                base.claimQuest(questId)
                if (questId == "two") throw IllegalStateException("reply interrupted")
            }
        }
        val model = model(repo)
        base.calls.clear()
        val owner = QuestsScope(Any(), "base-a", 4)
        val gate = QuestsActionGate(owner, { owner }, { model.busy.value }, { null }, {})
        val job = requireNotNull(model.claimAll(gate::requireCurrent))
        job.join()

        assertFalse(job.isCancelled)
        assertEquals(listOf("claim:one", "claim:two", "quests"), base.calls)
        assertEquals("1 CLAIMS CONFIRMED — REFRESHING; RETRY REMAINING QUESTS", model.notice.value?.message)
    }

    @Test fun `claim cancellation survives without a replacement cleanup error or stale notice`() = runTest {
        val base = FakeBaseRepository().also { it._state.value = readyState("one", "two") }
        val original = CancellationException("original claim cancellation")
        val repo = object : BaseRepository by base {
            override suspend fun claimQuest(questId: String) {
                base.claimQuest(questId)
                throw original
            }
        }
        val model = model(repo)
        base.calls.clear()
        var checks = 0
        val job = requireNotNull(model.claimAll {
            checks++
            if (checks > 2) throw IllegalStateException("cleanup must not replace original cancellation")
        })
        var completion: Throwable? = null
        job.invokeOnCompletion { completion = it }
        job.join()

        assertTrue(job.isCancelled)
        assertSame(original, completion)
        assertEquals(2, checks)
        assertEquals(listOf("claim:one"), base.calls)
        assertNull(model.notice.value)
    }

    @Test fun `batch rechecks ownership after refresh before publishing its count`() = runTest {
        val base = FakeBaseRepository().also { it._state.value = readyState("one") }
        val refreshReply = CompletableDeferred<Unit>()
        var holdRefresh = false
        val repo = object : BaseRepository by base {
            override suspend fun refreshQuests() {
                base.refreshQuests()
                if (holdRefresh) refreshReply.await()
            }
        }
        val model = model(repo)
        base.calls.clear()
        holdRefresh = true
        val expected = QuestsScope(Any(), "base-a", 4)
        var current: QuestsScope? = expected
        val gate = QuestsActionGate(expected, { current }, { model.busy.value }, { null }, {})
        val job = requireNotNull(model.claimAll(gate::requireCurrent))
        assertEquals(listOf("claim:one", "quests"), base.calls)
        current = QuestsScope(expected.session, "base-a", 6)
        refreshReply.complete(Unit)
        job.join()

        assertTrue(job.isCancelled)
        assertNull(model.notice.value)
        assertEquals(listOf("claim:one", "quests"), base.calls)
    }

    private fun model(base: BaseRepository): QuestsViewModel =
        QuestsViewModel(base, FakeContentRepository()).also { models += it }

    private fun readyState(vararg ids: String) = BaseState(quests = QuestBoard(
        quests = ids.map { Quest(id = it, completed = true) }))

    private fun expectCancellation(block: () -> Unit) {
        try {
            block()
            fail("A superseded quest owner must cancel its continuation")
        } catch (_: CancellationException) { }
    }

    private class RouteFixture {
        val identity = HomeRouteIdentity(Any(), "base-a", 4)
        var current: HomeRouteIdentity? = identity
        var blocked = false
        var standalone = 0
        val feature = FeatureId("hud.quests")
        val reasons = mutableListOf<String>()
        val opened = mutableListOf<Destination>()
        val requests = HomeRequests()
        val host = HomeSheetRouteHost({ current }, { blocked }, { reasons += it })
        val mount = host.attach(identity, {}, { false }, openBody = { opened += it }).also { it.reportBlocked(false) }
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(),
            { current?.let { HomeRouteContext(it, GateContext(baseId = it.baseId)) } }, host)

        fun tap(): Boolean = dispatcher.handleFeatureDoor(feature).also { if (!it) standalone++ }
    }
}
