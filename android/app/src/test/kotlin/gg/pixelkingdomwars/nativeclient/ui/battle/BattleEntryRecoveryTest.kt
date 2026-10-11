package gg.pixelkingdomwars.nativeclient.ui.battle

import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.*
import org.junit.Test

class BattleEntryRecoveryTest {
    private val error = "Can't connect to the game. Check your connection and try again."
    private val request = PendingBattleWrite("original", "/campaign/1/raid", buildJsonObject {}, attempted = true)

    @Test fun `failed preflight replaces the spinner and permits a fresh explicit attempt only before persistence`() {
        val state = LiveBattleState(error = error)
        val recovery = battleEntryRecovery(state, null, true, null)
        assertEquals(error, recovery.message)
        assertEquals(BattleEntryRetry.CREATE, recovery.retry)
        assertNull(battleEntryRecovery(state.copy(creating = true), error, true, null).retry)
        assertNull(battleEntryRecovery(state.copy(creating = true), error, true, null).message)
    }

    @Test fun `an uncertain create remains read recovery even after connectivity returns`() {
        val state = LiveBattleState(pending = PendingBattle("wallet", "base", create = request))
        val recovery = battleEntryRecovery(state, null, true, null)
        assertNotNull("A saved unresolved request must not return to an indefinite loader", recovery.message)
        assertEquals(BattleEntryRetry.CHECK, recovery.retry)
        assertFalse(recovery.leaveSavedView)
        assertNull(battleEntryRecovery(state.copy(inFlight = setOf("original")), null, true, null).retry)
        assertEquals(error, battleEntryRecovery(state.copy(error = error), null, true, null).message)
        val checked = battleEntryRecovery(state.copy(connected = true, error = null), null, true, null)
        // D153.333 (e): raids are instant, so the saved-request line must not imply travel (no "march" / "en route").
        assertEquals("Raids are instant: the saved-request line names a raid request, never a march",
            "Your raid request is awaiting confirmation. Check its status or retry the same saved request.", checked.message)
        assertEquals("Successful GET does not authorize another create", BattleEntryRetry.CHECK, checked.retry)
    }

    /** D153.333 (a): a terminal refusal of a retried create retires its key, leaving the overlay the server's line and no
     * saved request. It must show that line and offer a fresh create — never "awaiting confirmation", which would tell the
     * player to keep waiting for an answer that already came (the 2026-10-02 POST /raids 404). */
    @Test fun `a refused create with nothing saved shows the server's refusal and never awaiting-confirmation copy`() {
        val refused = "No other target available"
        val recovery = battleEntryRecovery(LiveBattleState(error = refused), null, true, null)
        assertEquals(refused, recovery.message)
        assertFalse(recovery.message.orEmpty().contains("awaiting", ignoreCase = true))
        assertEquals("Nothing is saved: the only retry is a new create under a fresh key", BattleEntryRetry.CREATE, recovery.retry)
        assertFalse(recovery.leaveSavedView)
    }

    @Test fun `acknowledged but unread battle can leave only its view and retry only its existing raid`() {
        val state = LiveBattleState(pending = PendingBattle("wallet", "base", raidId = "raid"), error = error)
        val recovery = battleEntryRecovery(state, null, true, null)
        assertEquals(BattleEntryRetry.CHECK, recovery.retry)
        assertTrue(recovery.leaveSavedView)
        assertFalse(battleEntryRecovery(state.copy(presentation = buildJsonObject {}), null, true, null).leaveSavedView)
        assertFalse(battleEntryRecovery(state.copy(expired = true), null, true, null).leaveSavedView)
    }

    @Test fun `pending server marches prevent fresh create and compatibility failures never offer a retry`() {
        val state = LiveBattleState(candidates = listOf(buildJsonObject {}))
        assertEquals(BattleEntryRetry.CHECK, battleEntryRecovery(state, null, true, null).retry)
        assertNotNull(battleEntryRecovery(state, null, true, null).message)
        assertNull(battleEntryRecovery(state.copy(blocked = true, error = "Update required"), null, true, null).retry)
    }

    @Test fun `local playback repair does not create another raid`() {
        val state = LiveBattleState(pending = PendingBattle("wallet", "base", raidId = "raid"), presentation = buildJsonObject {})
        assertEquals(BattleEntryRetry.PLAYBACK, battleEntryRecovery(state, null, true, "graphics").retry)
    }
}
