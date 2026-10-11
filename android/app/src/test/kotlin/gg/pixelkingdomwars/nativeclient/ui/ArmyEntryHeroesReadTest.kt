package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.HeroRoster
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyViewModel
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** 8b357d89: entry reads populate the Army hero rows, without a paid action. AUTHORED/UNRUN. */
@OptIn(ExperimentalCoroutinesApi::class)
class ArmyEntryHeroesReadTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private fun model(army: ArmyRepository, selected: () -> String? = { BASE_ID },
        content: ContentRepository = FakeContentRepository(), wallet: () -> String? = { WALLET }) = ArmyViewModel(army, FakeBaseRepository(), content,
        ReceiptObserver(PendingIntentStore(MemoryStore())), wallet, selected, InterruptedActions({}, {}, {}), 1)

    @Test fun `fresh Army entry loads the hero roster after the current army`() = runTest {
        val army = FakeArmyRepository(); val m = model(army); army.calls.clear()
        val roster = HeroRoster.from(json("""{"heroes":[]}"""))
        army.onCall = { if (it == "heroes") army._state.value = army._state.value.copy(heroes = roster, heroesBaseId = BASE_ID) }
        assertNull(m.state.value.domain.heroes)
        m.refreshTrainingFinish(includeHeroes = true)?.join()
        assertEquals(listOf("army", "heroes"), army.calls)
        // ReceiptObserver.refresh reads the journal on Dispatchers.IO, so the reads (and the combined UI state they feed)
        // finish on that thread; wait for the published state instead of racing it. A roster that never arrives still fails.
        val shown = m.state.first { it.domain.heroes != null }
        assertSame(roster, shown.domain.heroes); assertEquals(BASE_ID, shown.domain.heroesBaseId)
    }
    @Test fun `existing training timer and payment refresh does not add a hero read`() = runTest {
        val army = FakeArmyRepository(); val m = model(army); army.calls.clear()
        m.refreshTrainingFinish()?.join(); assertEquals(listOf("army"), army.calls)
    }
    @Test fun `last-base recovery has no current army or hero GET`() = runTest {
        val army = FakeArmyRepository(); val m = model(army, selected = { null })
        m.refreshTrainingFinish(includeHeroes = true)?.join(); assertTrue(army.calls.isEmpty())
    }
    @Test fun `replacement during army read does not start a hero read for the replacement`() = runTest {
        var selected: String? = BASE_ID
        val army = FakeArmyRepository(); val m = model(army, { selected }); army.calls.clear()
        army.onCall = { if (it == "army") selected = "replacement-base" }
        m.refreshTrainingFinish(includeHeroes = true)?.join(); assertEquals(listOf("army"), army.calls)
    }
    @Test fun `wallet replacement during army read prevents the hero GET`() = runTest {
        for (replacement in listOf("replacement-wallet", null)) {
            var wallet: String? = WALLET
            val army = FakeArmyRepository(); val m = model(army, wallet = { wallet }); army.calls.clear()
            army.onCall = { if (it == "army") wallet = replacement }
            m.refreshTrainingFinish(includeHeroes = true)?.join()
            assertEquals("Wallet changed to $replacement: no hero GET", listOf("army"), army.calls)
        }
    }
    @Test fun `retired client can read heroes without admitting any order`() = runTest {
        val army = FakeArmyRepository(); val m = model(army, content = FakeContentRepository(minimumBuild = 2)); army.calls.clear()
        assertFalse(m.state.value.ordersAllowed)
        m.refreshTrainingFinish(includeHeroes = true)?.join(); assertEquals(listOf("army", "heroes"), army.calls)
        assertFalse(m.state.value.ordersAllowed)
    }
    @Test fun `active entry read drops a second request without duplicated GET or any order`() = runTest {
        val fake = FakeArmyRepository(); val gate = CompletableDeferred<Unit>(); val calls = mutableListOf<String>()
        val entered = CompletableDeferred<Unit>()
        var selected: String? = null
        val army = object : ArmyRepository by fake {
            override suspend fun refreshArmy() { calls += "army"; entered.complete(Unit); gate.await() }
            override suspend fun refreshHeroes() { calls += "heroes" }
        }
        val m = model(army, { selected }); selected = BASE_ID
        val first = m.refreshTrainingFinish(includeHeroes = true)
        // The army GET starts after ReceiptObserver.refresh's Dispatchers.IO journal read; wait until it is in flight.
        assertNotNull(first); entered.await(); assertEquals(listOf("army"), calls)
        assertNull(m.refreshTrainingFinish(includeHeroes = true)); assertEquals(listOf("army"), calls)
        gate.complete(Unit); first?.join(); assertEquals(listOf("army", "heroes"), calls); assertTrue(fake.calls.isEmpty())
    }
    @Test fun `failed hero read becomes a notice and never enters a review or payment`() = runTest {
        val fake = FakeArmyRepository(); val moneyCalls = mutableListOf<String>()
        val army = object : ArmyRepository by fake {
            override suspend fun reviewHeroUpgrade(hero: String) { moneyCalls += "review-upgrade:$hero" }
            override suspend fun reviewHeroRecovery(hero: String) { moneyCalls += "review-recovery:$hero" }
            override suspend fun confirmHeroSpend() { moneyCalls += "confirm" }
        }
        val m = model(army); fake.calls.clear()
        fake.onCall = { if (it == "heroes") throw IllegalStateException("Hero read unavailable") }
        m.refreshTrainingFinish(includeHeroes = true)?.join()
        assertEquals(listOf("army", "heroes"), fake.calls); assertEquals("Hero read unavailable", m.notice.value?.message)
        assertTrue("No hero review or confirmation dispatched", moneyCalls.isEmpty())
    }
}
