package gg.pixelkingdomwars.nativeclient.ui

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.FakeAccountRepository
import gg.pixelkingdomwars.nativeclient.FakeBattleRepository
import gg.pixelkingdomwars.nativeclient.data.BattleRepository
import gg.pixelkingdomwars.nativeclient.model.Identity
import gg.pixelkingdomwars.nativeclient.ui.attack.AttackViewModel
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AttackReadNoticeTest {
    private val dispatcher = UnconfinedTestDispatcher()
    private val models = mutableListOf<AttackViewModel>()
    @Before fun main() { Dispatchers.setMain(dispatcher) }
    @After fun close() { models.forEach { it.viewModelScope.cancel() }; Dispatchers.resetMain() }

    private class Reads : BattleRepository by FakeBattleRepository() {
        var campaign: suspend () -> Unit = {}
        var history: suspend () -> Unit = {}
        override suspend fun refreshCampaign() = campaign()
        override suspend fun refreshHistory() = history()
        override suspend fun campaignBattle(stage: Int) { error("Original attack outcome still needs checking") }
    }
    private fun model(reads: Reads, account: FakeAccountRepository = FakeAccountRepository()) =
        AttackViewModel(reads, account).also { models += it }

    @Test fun `successful campaign polling removes the failed initial load without needing another user action`() = runTest(dispatcher) {
        val reads = Reads().apply { campaign = { error("baseId is required when multiple active bases exist") } }
        val model = model(reads)
        assertEquals("baseId is required when multiple active bases exist", model.campaignReadError.value)
        assertNull("A board failure must not become a durable action notice", model.notice.value)
        reads.campaign = {}
        model.readCampaign()
        assertNull(model.campaignReadError.value)
    }

    @Test fun `a failed manual refresh also belongs to the recoverable read notice`() = runTest(dispatcher) {
        val reads = Reads(); val model = model(reads)
        reads.campaign = { error("Temporary read failure") }
        model.refresh()
        assertEquals("Temporary read failure", model.campaignReadError.value)
        assertNull(model.notice.value)
        reads.campaign = {}; model.readCampaign()
        assertNull(model.campaignReadError.value)
    }

    @Test fun `a successful board read cannot dismiss an attack outcome notice`() = runTest(dispatcher) {
        val reads = Reads(); val model = model(reads)
        model.attack(100)
        val original = requireNotNull(model.notice.value)
        model.readCampaign()
        assertSame("Polling is not evidence about the original command", original, model.notice.value)
    }

    @Test fun `manual refresh preserves an attack outcome notice on both successful and failed reads`() = runTest(dispatcher) {
        val reads = Reads(); val model = model(reads)
        model.attack(100)
        val original = requireNotNull(model.notice.value)
        model.refresh()
        assertSame("A manual read is not evidence that the attack outcome was resolved", original, model.notice.value)
        reads.campaign = { error("Board unavailable") }
        model.refresh()
        assertSame(original, model.notice.value)
        assertEquals("Board unavailable", model.campaignReadError.value)
    }

    @Test fun `campaign success does not falsely clear a failed history read`() = runTest(dispatcher) {
        val reads = Reads().apply { history = { error("History unavailable") } }; val model = model(reads)
        assertEquals("History unavailable", model.historyReadError.value)
        model.readCampaign()
        assertEquals("Only the corresponding read can clear this notice", "History unavailable", model.historyReadError.value)
        reads.history = {}; model.refresh()
        assertNull(model.historyReadError.value)
    }

    @Test fun `an older failed poll cannot restore its error after a newer successful poll`() = runTest(dispatcher) {
        val reads = Reads(); val model = model(reads)
        val release = CompletableDeferred<Unit>()
        reads.campaign = { release.await(); error("Old failure") }
        val old = launch { try { model.readCampaign() } catch (_: IllegalStateException) {} }
        reads.campaign = {}; model.readCampaign()
        release.complete(Unit); old.join()
        assertNull(model.campaignReadError.value)
        assertNull(model.notice.value)
    }

    @Test fun `cancelled old base load cannot publish a notice even when the transport finishes late`() = runTest(dispatcher) {
        val account = FakeAccountRepository(); val release = CompletableDeferred<Unit>()
        var calls = 0
        val reads = Reads().apply { campaign = {
            if (++calls == 1) withContext(NonCancellable) { release.await(); error("Old base failed") }
        } }
        val model = model(reads, account)
        account._state.value = account._state.value.copy(selectedBaseId = "11111111-1111-4111-8111-111111111111")
        release.complete(Unit); runCurrent()
        assertTrue("The new base must still refresh", calls >= 2)
        assertNull(model.campaignReadError.value)
        assertNull(model.notice.value)
    }

    @Test fun `account replacement at the same base clears old read state and fences its late error`() = runTest(dispatcher) {
        val account = FakeAccountRepository(); val release = CompletableDeferred<Unit>()
        var calls = 0
        val reads = Reads().apply { campaign = {
            if (++calls == 1) withContext(NonCancellable) { release.await(); error("Old account failed") }
        } }
        val model = model(reads, account)
        account._state.value = account._state.value.copy(identity = Identity("another-test-wallet", entryPaid = false))
        release.complete(Unit); runCurrent()
        assertTrue("A changed identity refreshes even when the base ID has not changed", calls >= 2)
        assertNull(model.campaignReadError.value)
        assertNull(model.notice.value)
    }
}
