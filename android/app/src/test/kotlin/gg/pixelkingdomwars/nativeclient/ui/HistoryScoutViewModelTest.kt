package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.BattleHistoryState
import gg.pixelkingdomwars.nativeclient.model.BattleOpponent
import gg.pixelkingdomwars.nativeclient.model.BattleRecord
import gg.pixelkingdomwars.nativeclient.ui.attack.AttackViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HistoryScoutViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private val row = BattleRecord("raid", BASE_ID, "defender", "pvp", null, "defeat", 1, "20", "-1", "-1", "SHARDS", false,
        BattleOpponent("11111111-1111-4111-8111-111111111111", WALLET, "Kane", false), null)
    @Test fun `scouting a displayed revenge target only reads that exact opponent`() = runTest {
        val battle = FakeBattleRepository(); battle._state.value = battle._state.value.copy(history = BattleHistoryState(deed = listOf(row)))
        val model = AttackViewModel(battle); battle.calls.clear()
        model.scout(row); runCurrent()
        assertEquals(listOf("scout:$WALLET:11111111-1111-4111-8111-111111111111"), battle.calls)
    }
    @Test fun `removed and non-PvP rows cannot issue a scout or attack`() = runTest {
        val battle = FakeBattleRepository(); val model = AttackViewModel(battle); battle.calls.clear()
        model.scout(row); runCurrent(); assertTrue(battle.calls.isEmpty()); assertNotNull(model.notice.value)
        model.scout(row.copy(mode = "campaign")); model.scout(row.copy(role = "attacker")); runCurrent()
        assertTrue(battle.calls.isEmpty())
    }
}
