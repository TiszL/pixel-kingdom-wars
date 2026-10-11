package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.HarvesterReview
import gg.pixelkingdomwars.nativeclient.data.HarvesterState
import gg.pixelkingdomwars.nativeclient.harvester.*
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionHome
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.BackRegistry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.io.File

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class HomeHarvesterReviewTest {
    @Test fun `START opens existing owner review and only explicit exact confirmation submits`() = runTest {
        val f = Fixture()
        assertTrue(f.control.open(f.facility.harvesterId))
        assertEquals(listOf("review"), f.calls)
        val review = requireNotNull(f.control.review)
        assertSame(f.state.review, review)
        assertTrue(f.control.confirm(review))
        assertEquals(listOf("review", "confirm"), f.calls)
        assertFalse(f.control.confirm(review))
    }

    @Test fun `blocked session base and generation refuse open and exact confirmation`() = runTest {
        for (change in listOf("admission", "session", "base", "generation")) {
            val f = Fixture(); assertTrue(f.control.open(f.facility.harvesterId))
            val review = requireNotNull(f.control.review)
            when (change) {
                "admission" -> f.allowed = false
                "session" -> f.current = f.identity.copy(session = Any())
                "base" -> f.current = f.identity.copy(baseId = id(88))
                else -> f.current = f.identity.copy(baseSelectionGeneration = 5)
            }
            assertFalse(change, f.control.confirm(review))
            assertFalse(change, f.control.open(f.facility.harvesterId))
            assertEquals(listOf("review"), f.calls)
        }
    }

    @Test fun `foreign owner review remains held and is never adopted or dismissed`() = runTest {
        val f = Fixture(); val foreign = f.makeReview()
        f.state = f.state.copy(review = foreign)
        assertFalse(f.control.open(f.facility.harvesterId))
        assertFalse(f.control.currentAndAdmitted())
        assertNull(f.control.review)
        f.control.cancel(force = true)
        assertSame(foreign, f.state.review)
        assertTrue(f.calls.isEmpty())
    }

    @Test fun `changed selected facility cannot replace the facility on the displayed START`() = runTest {
        val f = Fixture(); f.selected = id(77)
        assertFalse(f.control.open(f.facility.harvesterId))
        assertTrue(f.calls.isEmpty())
    }

    @Test fun `paused busy absent and ambiguous current views never start`() = runTest {
        for (change in listOf("paused", "busy", "home", "view", "wallet", "facility", "ambiguous")) {
            val f = Fixture(); val v = requireNotNull(f.state.view)
            f.state = when (change) {
                "paused" -> f.state.copy(view = v.copy(acceptingSelections = false))
                "busy" -> f.state.copy(busy = true)
                "home" -> f.state.copy(view = v.copy(home = null))
                "view" -> f.state.copy(view = null)
                "wallet" -> f.state.copy(view = v.copy(wallet = "other-wallet"))
                "facility" -> f.state.copy(view = v.copy(facilities = emptyList()))
                else -> f.state.copy(view = v.copy(facilities = listOf(f.facility, f.facility.copy(harvesterId = id(77)))))
            }
            if (change == "ambiguous") f.selected = null
            assertFalse(change, f.control.open(if (change == "ambiguous") null else f.facility.harvesterId))
            assertTrue(change, f.calls.isEmpty())
        }
    }

    @Test fun `saved draft and attempted request re-review their exact key without starting a new command`() = runTest {
        for (attempt in listOf(null, 7L)) {
            val f = Fixture(); val command = f.makeReview().command
            f.state = f.state.copy(journal = f.state.journal.copy(operation = HarvesterOperation(command, attempt, null, null)))
            assertTrue(f.control.open(f.facility.harvesterId))
            assertEquals(listOf("saved"), f.calls)
            assertEquals(command.key, f.control.review!!.command.key)
            assertEquals(command, f.state.journal.operation!!.command)
        }
    }

    @Test fun `saved other source refused and accepted outcomes stay with recovery owner`() = runTest {
        for (change in listOf("base", "facility", "refused", "accepted")) {
            val f = Fixture(); val original = f.makeReview().command
            val command = when (change) {
                "base" -> original.copy(request = original.request.copy(baseId = id(88)))
                "facility" -> original.copy(request = original.request.copy(harvesterId = id(77)))
                else -> original
            }
            val proof = if (change == "accepted") HarvesterProof(f.wallet, command.key, f.now, "accepted", null, null) else null
            val refusal = if (change == "refused") HarvesterRefusal(503, "EXPEDITION_TERM_UNAVAILABLE") else null
            f.state = f.state.copy(journal = f.state.journal.copy(operation = HarvesterOperation(command, 7L, proof, refusal)))
            assertFalse(change, f.control.open(f.facility.harvesterId))
            assertTrue(change, f.calls.isEmpty())
        }
    }

    @Test fun `cancel retires only the owned review while keeping its original saved request`() = runTest {
        val f = Fixture(); assertTrue(f.control.open(f.facility.harvesterId))
        val journal = f.state.journal
        f.control.cancel()
        assertNull(f.state.review); assertNull(f.control.review)
        assertSame(journal, f.state.journal)
        assertEquals(listOf("review", "dismiss"), f.calls)
    }

    @Test fun `late review after identity or admission loss is dismissed without confirmation`() = runTest {
        for (identity in listOf(true, false)) {
            val f = Fixture(); f.afterReview = { if (identity) f.current = null else f.allowed = false }
            assertFalse(f.control.open(f.facility.harvesterId))
            assertNull(f.control.review); assertNull(f.state.review)
            assertNotNull(f.state.journal.operation)
            assertEquals(listOf("review", "dismiss"), f.calls)
        }
    }

    @Test fun `replaced review rejects old confirm and keeps the replacement intact`() = runTest {
        val f = Fixture(); assertTrue(f.control.open(f.facility.harvesterId))
        val displayed = requireNotNull(f.control.review)
        val replacement = f.makeReview(); f.state = f.state.copy(review = replacement)
        assertFalse(f.control.confirm(displayed))
        f.control.cancel(force = true)
        assertSame(replacement, f.state.review)
        assertEquals(listOf("review"), f.calls)
    }

    @Test fun `double tap during confirm cannot enter owner twice`() = runTest {
        val f = Fixture(); assertTrue(f.control.open(f.facility.harvesterId))
        val review = requireNotNull(f.control.review)
        val entered = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        f.confirming = { entered.complete(Unit); finish.await() }
        val first = launch { assertTrue(f.control.confirm(review)) }
        entered.await()
        assertTrue(f.control.holding)
        assertFalse(f.control.confirm(review))
        finish.complete(Unit); first.join()
        assertEquals(1, f.calls.count { it == "confirm" })
    }

    @Test fun `busy review ignores ordinary Back but lifecycle retirement invalidates it preserving evidence`() = runTest {
        val f = Fixture(); assertTrue(f.control.open(f.facility.harvesterId))
        val review = requireNotNull(f.control.review); val journal = f.state.journal
        f.state = f.state.copy(busy = true)
        f.control.cancel(); assertSame(review, f.state.review)
        f.control.cancel(force = true); assertNull(f.state.review)
        assertSame(journal, f.state.journal)
    }

    @Test fun `a pending review read holds navigation and disposal invalidates its late result`() = runTest {
        val f = Fixture(); val resume = CompletableDeferred<Unit>()
        f.beforeReview = { resume.await() }
        val pending = launch { f.control.open(f.facility.harvesterId) }
        runCurrent(); assertTrue(f.control.holding)
        f.control.cancel(force = true)
        resume.complete(Unit); pending.join()
        assertNull(f.control.review)
        assertEquals(0, f.calls.count { it == "confirm" })
    }

    @Test fun `only exact Harvester confirmation Back lease gets own-review exception`() {
        val registry = BackRegistry(); val presence = HomeHarvesterReviewPresence()
        val owned = registry.register(BackPriority.CONFIRM) {}; presence.back = owned
        assertTrue(presence.ownsBack(registry.active()))
        val foreign = registry.register(BackPriority.CONFIRM) {}
        assertFalse(presence.ownsBack(registry.active()))
        registry.unregister(foreign); registry.unregister(owned)
        assertFalse(presence.ownsBack(registry.active()))
    }

    @Test fun `review copy preserves full frozen policy original key and replaced source`() {
        val f = Fixture()
        val previous = HarvesterSummary(id(9), id(8), id(7), 1, "elderwood", "heartwood_logs", "2026-10-04T00:00:00Z", "2026-10-05T00:00:00Z")
        val base = f.makeReview()
        val review = base.copy(command = base.command.copy(replacedSource = previous,
            request = base.command.request.copy(expectedSourceId = previous.sourceId)))
        val lines = homeHarvesterReviewLines(review, attempted = true).joinToString("\n")
        for (value in listOf(f.facility.harvesterId, f.identity.baseId, review.command.key, previous.sourceId,
            previous.baseId, previous.harvesterId, previous.admittedAt, previous.leaseExpiresAt, "77", "7", "UTC", "same saved"))
            assertTrue(value, lines.contains(value))
        assertTrue(lines.contains("not spendable"))
        assertFalse(lines.contains("Nothing was spent"))
    }

    @Test fun `START mount stays in sheet while accepted clock and history recovery remain`() {
        // Repointed to the live host after the mount: Home mounts HomeHarvesterOwnerSheet (HomeHarvesterSheet stays as
        // dead source in HomeRouteDispatcher.kt tonight).
        val host = source("ui/home/HomeHarvesterOwnerSheet.kt").substringAfter("@Composable internal fun HomeHarvesterOwnerSheet(")
        assertTrue(host.contains("reviewController?.open("))
        assertFalse(host.contains("reviewStart = { if (canCheckNow()) onLegacy()"))
        // Rewritten for the designed recovery state (craft SPEC §5): the re-review of a saved request is no longer a raw
        // chrome TextButton above the sheet but the sheet's own kit button under the recovery row, wired to the same
        // guarded openReview of the saved request's Harvester, so it explains instead of sitting silently disabled.
        assertFalse(host.contains("TextButton("))
        assertTrue(host.contains("if (saved != null) openReview(saved.command.request.harvesterId)"))
        assertTrue(source("ui/sheets/craft/HarvesterSheet.kt").contains("SecondaryButton(\"REVIEW SAVED REQUEST\", on.onReviewSaved"))
        assertTrue(host.contains("System.currentTimeMillis()"))
        assertTrue(host.contains("harvesterHistoryLiveUi("))
        assertTrue(host.contains("onOpenOriginal ="))
    }

    @Test fun `dedicated review scrolls complete consent and never calls a repository constructor`() {
        val overlay = source("ui/home/HomeHarvesterReview.kt")
        assertTrue(overlay.contains("verticalScroll("))
        assertTrue(overlay.contains("maxLines = Int.MAX_VALUE"))
        assertTrue(overlay.contains("Lifecycle.Event.ON_STOP"))
        assertFalse(overlay.contains("Repository("))
        assertFalse(overlay.contains("ViewModel("))
    }

    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }

    private class Fixture {
        val wallet = "DaEy4YZ9xwiGzw1nTQVB1vxCTZRBQJhbmLU55BXQ2jgi"
        val identity = HomeRouteIdentity(Any(), id(1), 2)
        var current: HomeRouteIdentity? = identity
        var allowed = true
        var selected: String? = id(2)
        val now = "2026-10-05T04:00:00Z"
        val facility = HarvesterFacility(id(1), id(2), id(3), "2026-10-04T04:00:00Z")
        val policy = HarvesterPolicy(1, 1, "77", "7", 600, 3600, 1, 10000, 500)
        private val view = HarvesterView(wallet, id(1), now, HarvesterFeatures(HarvesterFeature(1, 1)), true,
            StarterExpeditionHome("free_assignment", 1, "crownlands"), listOf(facility), null, null, policy, emptyList())
        var state = HarvesterState(HarvesterJournal(1, HarvesterIdentity("https://api.example.gg", "devnet", wallet), 1, null, emptyList()), view, advertised = true)
        val calls = mutableListOf<String>()
        var beforeReview: suspend () -> Unit = {}
        var afterReview: () -> Unit = {}
        var confirming: suspend () -> Unit = {}
        fun makeReview(command: HarvesterCommand? = null) = HarvesterReview(command ?: HarvesterCommand(
            HarvesterRequest(id(4), id(1), id(2), null, 1), facility, "crownlands", policy, null), requireNotNull(state.view), 0, 2)
        private suspend fun publish(command: HarvesterCommand? = null) {
            beforeReview()
            val review = makeReview(command)
            state = state.copy(review = review, journal = state.journal.copy(operation =
                state.journal.operation ?: HarvesterOperation(review.command, null, null, null)))
            afterReview()
        }
        val control = HomeHarvesterReviewController(identity, { current }, { allowed }, { state }, { selected },
            reviewSelection = { calls += "review"; publish() },
            reviewSaved = { calls += "saved"; publish(state.journal.operation!!.command) },
            confirmReview = { calls += "confirm"; confirming(); state = state.copy(review = null) },
            dismissReview = { calls += "dismiss"; state = state.copy(review = null) })
    }
    companion object {
        private fun id(n: Int) = "12345678-1234-4678-9abc-" + n.toString().padStart(12, '0')
    }
}
