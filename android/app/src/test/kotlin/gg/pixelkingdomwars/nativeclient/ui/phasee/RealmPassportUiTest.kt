package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RealmPassportUiTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val model = RealmPassportViewModel(RealmPassportRepository(session, holder, api))
        init {
            api.onGet("/realm-passport/expeditions") { PassportTestWire.expeditions(it.getValue("kind")) }
            api.onGet("/realm-passport/mining/inclusions") { PassportTestWire.inclusions() }
            api.onGet("/realm-passport/mining/current") { PassportTestWire.current() }
        }
    }
    @Test fun `refresh checks independent history and current sources even when current is unavailable`() = runTest {
        val f = Fixture(); f.api.onGet("/realm-passport/mining/current") { PassportTestWire.unavailable() }
        f.model.refresh()?.join()
        assertNotNull(f.model.state.value.expeditions.observation!!.data); assertNotNull(f.model.state.value.inclusions.observation!!.data)
        assertNull(f.model.state.value.current.observation!!.data)
    }
    @Test fun `tab switch reloads its own first page without reusing other kind cursor`() = runTest {
        val f = Fixture(); f.model.refresh()?.join(); f.model.selectKind("advanced"); runCurrent()
        assertEquals("advanced", f.model.kind.value); assertEquals(mapOf("kind" to "advanced"), f.api.gets.last().second)
        assertEquals("advanced", f.model.state.value.expeditions.observation!!.data!!.kind)
    }
    @Test fun `close cancels unfinished page and reopen starts fresh without mutations`() = runTest {
        val f = Fixture(); val entered = CompletableDeferred<Unit>()
        f.api.onGet("/realm-passport/expeditions") { entered.complete(Unit); awaitCancellation() }
        f.model.refresh(); entered.await(); f.model.dismiss(); runCurrent()
        assertNull(f.model.state.value.expeditions.observation); assertFalse(f.model.state.value.expeditions.busy)
        f.api.onGet("/realm-passport/expeditions") { PassportTestWire.expeditions(it.getValue("kind")) }
        f.model.refresh()?.join(); assertNotNull(f.model.state.value.current.observation)
        assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `mining day display guards unrepresentable dates and preserves ordinal`() {
        assertEquals("1970-01-01 UTC", passportDayLabel("0"))
        assertEquals("Mining day 18446744073709551615", passportDayLabel("18446744073709551615"))
        assertEquals("2026-09-30 · 12:00 UTC", passportTimeLabel("2026-09-30T12:00:00.000Z"))
    }
    @Test fun `source detail disclosure preserves actor publication identity and each proof component`() {
        val row = RealmPassportWire.inclusions(PassportTestWire.inclusions(), WALLET, null).data!!.rows.single()
        val details = passportInclusionDetails(row)
        assertTrue(details.any { it.label == "Wallet" && it.value == WALLET })
        assertTrue(details.any { it.label == "Source hash" && it.value == row.sourceHash })
        assertTrue(details.any { it.label == "Publication signature" && it.value == row.publicationSignature })
        assertTrue(details.any { it.label.contains("Proof 1") && it.value.contains(row.proof.single().hash) && it.value.contains(row.proof.single().sumBaseUnits) })
    }
    @Test fun `history entry belongs to existing activities and leaves no retired session action`() {
        val registry = PhaseEActivityRegistry(); val owner = Any(); var opened = 0
        registry.register(PhaseEActivity.REALM_PASSPORT, owner) { opened++ }
        registry.open(); assertTrue(registry.choose(PhaseEActivity.REALM_PASSPORT)); assertEquals(1, opened)
        assertEquals(PhaseEActivityGroup.KINGDOMS, PhaseEActivity.REALM_PASSPORT.group)
        registry.dispose(); registry.open(); assertFalse(registry.choose(PhaseEActivity.REALM_PASSPORT))
    }
    @Test fun `ordinary close retains discovered entry but removes rows and stop requires fresh discovery`() = runTest {
        val f = Fixture(); f.model.discover()?.join(); f.model.refresh()?.join()
        assertTrue(f.model.state.value.discoverable); assertNotNull(f.model.state.value.expeditions.observation)
        f.model.close(); assertEquals(RealmPassportState(discoverable = true), f.model.state.value)
        val before = f.api.gets.size; f.model.discover()?.join(); assertEquals(before, f.api.gets.size)
        f.model.dismiss(); assertFalse(f.model.state.value.discoverable)
        f.model.discover()?.join(); assertEquals(before + 1, f.api.gets.size)
        assertNull(f.model.state.value.expeditions.observation)
    }

}
