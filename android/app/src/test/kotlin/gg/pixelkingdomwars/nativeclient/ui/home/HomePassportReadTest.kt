package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.features.GateFact
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.passportTripsText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.passportLiveUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.SourceState
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.model.BaseSummary
import androidx.compose.runtime.AbstractApplier
import androidx.compose.runtime.BroadcastFrameClock
import androidx.compose.runtime.Composition
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import java.time.ZoneOffset
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class HomePassportReadTest {
    private fun page(kind: String, cursor: String? = null) = PassportSection(PassportObservation(
        PassportExpeditions(kind, emptyList(), cursor), "2026-10-05T00:00:00.000Z", null))

    @Test fun `only a verified available expedition observation opens Passport`() {
        assertEquals(GateFact.Unknown, homePassportFeatureFact(null))
        assertEquals(GateFact.Unknown, homePassportFeatureFact(RealmPassportState(discoverable = true)))
        assertEquals(GateFact.Allowed, homePassportFeatureFact(RealmPassportState(expeditions = page("starter"))))
        val unavailable = RealmPassportState(expeditions = PassportSection(PassportObservation(null, "now", "NOT_CONFIGURED")))
        assertEquals(GateFact.Denied("Passport is not open on this server yet"), homePassportFeatureFact(unavailable))
    }

    @Test fun `paging awaits every page and keeps totals partial until both kinds are complete`() = runTest {
        val reads = mutableListOf<Boolean>()
        val held = HomePassportPages()
        readHomePassportKind("starter", { true }, { next -> reads += next; page("starter", if (next) null else "cursor-a") }, held::observe)
        assertEquals(listOf(false, true), reads)
        assertEquals("0+", passportTripsText(listOf(held.starter, held.advanced)))
        readHomePassportKind("advanced", { true }, { page("advanced") }, held::observe)
        assertEquals("0", passportTripsText(listOf(held.starter, held.advanced)))
    }

    @Test fun `lost admission discards a late page and issues no following request`() = runTest {
        var admitted = true; var reads = 0
        val held = HomePassportPages()
        readHomePassportKind("starter", { admitted }, { reads++; admitted = false; page("starter", "next") }, held::observe)
        assertEquals(1, reads)
        assertNull(held.starter)
    }

    @Test fun `repeated cursor stops paging without claiming a complete history`() = runTest {
        var reads = 0; val held = HomePassportPages()
        readHomePassportKind("starter", { true }, { reads++; page("starter", "same") }, held::observe)
        assertEquals(2, reads)
        assertFalse(requireNotNull(held.starter).complete)
    }

    @Test fun `a later good kind cannot hide the earlier failed history source`() {
        val held = HomePassportPages()
        val failure = PassportSection<PassportExpeditions>(error = "History could not be verified")
        held.observe(failure); held.observe(page("advanced"))
        assertSame(failure, held.failure)
        assertNull(held.starter)
        assertTrue(requireNotNull(held.advanced).complete)
        held.beginRefresh(); assertNull(held.failure)
        assertTrue(requireNotNull(held.advanced).complete)
    }

    @Test fun `unconfigured advanced history leaves starter Passport available without inventing complete stamps`() = runTest {
        val held = HomePassportPages(); val reads = mutableListOf<String>()
        var state = RealmPassportState()
        val unconfigured = PassportSection<PassportExpeditions>(PassportObservation(null, "now", "NOT_CONFIGURED"))
        readHomePassportPages(held, { true }) { kind, next ->
            assertFalse(next); reads += kind
            (if (kind == "advanced") unconfigured else page("starter")).also { state = state.copy(expeditions = it) }
        }
        assertEquals(listOf("advanced", "starter"), reads)
        assertNull(held.failure); assertNull(held.advanced)
        assertTrue(requireNotNull(held.starter).complete)
        assertEquals(GateFact.Allowed, homePassportFeatureFact(state))
        val ui = passportLiveUi(state, held.starter, held.advanced, null, 1, 0L, ZoneOffset.UTC)
        assertEquals(SourceState.OK, ui.sourceState); assertTrue(ui.stamps.isEmpty()); assertEquals("0+", ui.trips)
        held.observeKind(unconfigured, "starter")
        assertSame(unconfigured, held.failure) // Only advanced NOT_CONFIGURED is optional.
    }

    @Test fun `interrupted advanced read recovers the starter witness once without waiting for app background`() = runTest {
        var state = RealmPassportState(expeditions = PassportSection(PassportObservation(null, "now", "NOT_CONFIGURED")))
        var reads = 0
        val read: suspend () -> Unit = { reads++; state = state.copy(expeditions = page("starter")) }
        recoverHomePassportStarter({ state }, { true }, { true }, {}, read)
        assertEquals(1, reads); assertEquals(GateFact.Allowed, homePassportFeatureFact(state))
        recoverHomePassportStarter({ state }, { true }, { true }, {}, read)
        assertEquals(1, reads) // A current starter witness never starts another read.
    }

    @Test fun `Passport recovery waits for the owner and rechecks admission and session before reading`() = runTest {
        var state = RealmPassportState(expeditions = page("advanced"))
        var allowed = true; var current = true; var reads = 0
        val waiting = CompletableDeferred<Unit>(); val idle = CompletableDeferred<Unit>()
        val read: suspend () -> Unit = { reads++; state = state.copy(expeditions = page("starter")) }
        val recovering = launch {
            recoverHomePassportStarter({ state }, { current }, { allowed }, { waiting.complete(Unit); idle.await() }, read)
        }
        waiting.await(); allowed = false; idle.complete(Unit); recovering.join()
        assertEquals(0, reads)
        allowed = true; current = false
        recoverHomePassportStarter({ state }, { current }, { allowed }, {}, read)
        assertEquals(0, reads)
        current = true
        recoverHomePassportStarter({ state }, { current }, { allowed }, {}, read)
        assertEquals(1, reads); assertEquals(GateFact.Allowed, homePassportFeatureFact(state))
    }

    // WHY: the Lodge sheet stays open while Passport reads land and while the deed directory learns the base's realm.
    // Facts read once with `.value` left the PASSPORT tab locked (or open) and its realm stale until something unrelated
    // recomposed the sheet; each emission below must reach the composition on its own.
    @Test fun `an open Lodge recomposes on a new Passport observation and on the base realm`() = runTest {
        val base = BaseSummary("base-1", "active", slot = 0)
        val account = MutableStateFlow(AccountState(directory = BaseDirectory(bases = listOf(base))))
        val passport = MutableStateFlow(RealmPassportState())
        val owner = mutableStateOf<StateFlow<RealmPassportState>?>(passport)
        val clock = BroadcastFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val composition = Composition(object : AbstractApplier<Unit>(Unit) {
            override fun insertTopDown(index: Int, instance: Unit) = Unit
            override fun insertBottomUp(index: Int, instance: Unit) = Unit
            override fun remove(index: Int, count: Int) = Unit
            override fun move(from: Int, to: Int, count: Int) = Unit
            override fun onClear() = Unit
        }, recomposer)
        val runner = launch(clock) { recomposer.runRecomposeAndApplyChanges() }
        val seen = mutableListOf<HomeLodgePassportFacts>()
        var frame = 0L
        fun settle() { runCurrent(); Snapshot.sendApplyNotifications(); runCurrent(); clock.sendFrame(frame++); runCurrent() }
        composition.setContent {
            val facts = homeLodgePassportFacts(account, "base-1", owner.value)
            SideEffect { seen += facts }
        }
        try {
            settle()
            assertEquals(HomeLodgePassportFacts(null, false), seen.last())
            passport.value = RealmPassportState(expeditions = page("starter")); settle()
            assertEquals(HomeLodgePassportFacts(null, true), seen.last())
            val placed = base.copy(fantasyLocation = JsonObject(mapOf("realmId" to JsonPrimitive("emberfall"))))
            account.value = AccountState(directory = BaseDirectory(bases = listOf(placed))); settle()
            assertEquals(HomeLodgePassportFacts("emberfall", true), seen.last())
            passport.value = RealmPassportState(expeditions = PassportSection(PassportObservation(null, "now", "NOT_CONFIGURED")))
            settle()
            assertEquals(HomeLodgePassportFacts("emberfall", false), seen.last())
            // No current owner (signed out, replaced session): availability is withdrawn, the realm stays.
            passport.value = RealmPassportState(expeditions = page("starter")); settle()
            assertTrue(seen.last().available)
            owner.value = null; settle()
            assertEquals(HomeLodgePassportFacts("emberfall", false), seen.last())
        } finally { composition.dispose(); recomposer.cancel(); runner.join() }
    }

    // WHY: the observed facts help only where the sheet uses them; a restored one-shot `.value` read is the defect.
    @Test fun `the Lodge sheet takes its realm and Passport availability from the observed facts`() {
        val lodge = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeLodgeLiveSheet.kt").readText()
        assertTrue(lodge.contains("val passportFacts = homeLodgePassportFacts(graph.account.state, identity.baseId, " +
            "passportOwner?.takeIf { it.current() }?.model?.state)"))
        assertTrue(lodge.contains("homeLodgePassport(passportOwner, identity, currentTab == \"PASSPORT\", passportFacts.homeRealmId,"))
        assertTrue(lodge.contains("val passportAvailable = passportFacts.available"))
        assertFalse(lodge.contains("graph.account.state.value"))
        assertFalse(lodge.contains("?.model?.state?.value"))
    }
}
