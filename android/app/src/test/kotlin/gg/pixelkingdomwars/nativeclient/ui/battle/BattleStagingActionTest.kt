package gg.pixelkingdomwars.nativeclient.ui.battle

import androidx.lifecycle.viewModelScope

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.BattleRepository
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BattleStagingActionTest {
    @Test fun `orders queued by a held pointer recheck admission before any command can allocate or persist an ID`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var allowed = true; var submitted = 0; var paused = 0
            val battle = object : BattleRepository by FakeBattleRepository() {
                override fun stagingInputAllowed(coordinator: BattleCoordinator) = allowed
                override fun battleAction(action: suspend () -> Unit) = backgroundScope.launch {
                    try { action() } catch (_: IllegalStateException) { paused++ }
                }
            }
            val coordinator = BattleCoordinator.withTransport("wallet", "base", 15, PendingBattleStore(MemoryStore()),
                { _, _ -> error("No network read") }, { _, _ -> error("No network post") }, { emptyFlow() })
            val model = BattleViewModel(battle, FakeContentRepository())
            repeat(4) { model.stagingAction(coordinator) { submitted++ } }
            allowed = false; runCurrent()
            assertEquals(0, submitted); assertEquals(4, paused)
            // Ordinary recovery/retreat actions retain their original path while staging is paused.
            model.action { submitted++ }; runCurrent(); assertEquals(1, submitted)
            model.viewModelScope.cancel()
        } finally { Dispatchers.resetMain() }
    }
}
