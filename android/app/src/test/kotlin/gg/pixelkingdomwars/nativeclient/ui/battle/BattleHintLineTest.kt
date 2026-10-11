package gg.pixelkingdomwars.nativeclient.ui.battle

import gg.pixelkingdomwars.nativeclient.data.StagingReservationStatus
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

/** Owner 2026-09-17/18: the battle HUD has exactly one hint line, in a slot of fixed height, and deploying troops
 * must not put, change or flash any text on the battle screen. This file used to pin the opposite for one case —
 * an invalid tap borrowed the line for 2.5 s ("TAP CLEAR GROUND…") — which, when deploying fast, rewrote the HUD
 * on every stray tap. That borrow is gone (the web drops an invalid tap silently too); the tests now pin the new
 * rule: the prompt lives until the first troop is committed, then the line is blank with its slot kept. */
class BattleHintLineTest {
    private fun live(phase: BattlePhase = BattlePhase.STAGING, commands: Int = 0) = LiveBattleState(phase = phase,
        pending = PendingBattle("wallet", "base", "raid"),
        commands = (0 until commands).map { buildJsonObject { put("kind", "deploy"); put("sequence", it) } })
    private fun line(state: LiveBattleState, committed: Boolean, selection: String? = "ARCHER", destroyed: Int? = null,
        field: BattleHudProgress.Field? = null, reservesLeft: Boolean = true, staging: Boolean = true) =
        battleHintLine(state, staging, StagingReservationStatus.OPEN, nextTargetIntent = false, retreating = false,
            destroyed = destroyed, field = field, reservesLeft = reservesLeft, committed = committed, selection = selection)

    @Test fun `the deploy prompt lives only until the first troop is committed and then the line is blank, never absent`() {
        assertEquals("TAP THE FIELD TO DEPLOY · ARCHER", line(live(), committed = false))
        assertEquals("DEPLOY RESERVES", line(live(BattlePhase.RUNNING), committed = false, selection = null))
        for (deployed in 1..40) {
            val hint = line(live(BattlePhase.RUNNING, commands = deployed), committed = true, field = BattleHudProgress.Field(deployed, deployed))
            assertEquals("Deploy #$deployed must not write a line such as DEPLOY RESERVES · ARCHER", "", hint)
        }
        assertNotNull("A blank line still reserves its slot: null would remove the slot and resize the HUD", line(live(), committed = true))
    }
    @Test fun `a changed selection cannot bring text back once troops are committed`() {
        assertEquals(line(live(BattlePhase.RUNNING, 3), committed = true, selection = "DRAGON"), line(live(BattlePhase.RUNNING, 3), committed = true, selection = "ARCHER"))
    }
    @Test fun `battle state messages that no deploy produces keep the line`() {
        val running = live(BattlePhase.RUNNING, commands = 2)
        assertEquals("TARGET DESTROYED · CONFIRMING RESULT…", line(running, committed = true, destroyed = 100))
        assertEquals("YOUR TROOPS FELL · THE FIGHT IS STILL ON · DEPLOY MORE OR RETREAT", line(running, committed = true, field = BattleHudProgress.Field(2, 0)))
        assertEquals("NO TROOPS LEFT · RESULT AT THE CLOCK END", line(running, committed = true, field = BattleHudProgress.Field(2, 0), reservesLeft = false))
        assertEquals("CHECKING THIS MARCH…", battleHintLine(live(), false, StagingReservationStatus.CHECKING, false, false, null, null, true, false, null))
    }
    @Test fun `without a march or after the result there is no line and nothing is reserved`() {
        assertNull(line(LiveBattleState(), committed = false))
        assertNull(line(live().copy(result = buildJsonObject { put("stars", 3) }), committed = true))
    }
    @Test fun `committed means accepted, saved or still being admitted, so the first tap already retires the prompt`() {
        fun write(kind: String) = PendingBattleWrite("id-$kind", "/raids/raid/commands", buildJsonObject { put("command", buildJsonObject { put("kind", kind) }) })
        assertFalse(battleTroopsCommitted(live()))
        assertFalse("A buff is not a troop", battleTroopsCommitted(live().copy(preparingWrites = listOf(write("buff")))))
        assertTrue(battleTroopsCommitted(live().copy(preparingWrites = listOf(write("deploy")))))
        assertTrue(battleTroopsCommitted(live().let { it.copy(pending = it.pending!!.copy(writes = listOf(write("hero")))) }))
        assertTrue(battleTroopsCommitted(live(commands = 1)))
    }
    /** A replacement revision's progress index is null while it is rebuilt; the display holds the last value. */
    @Test fun `progress shown by the HUD never flashes back to unknown while a new revision is prepared`() {
        val stars = BattleHudLatch<Int>(); val destroyed = BattleHudLatch<Int>()
        assertNull("Before the first index there is honestly nothing to show", destroyed.offer(null))
        val perRevision = listOf<Pair<Int, Int?>?>(1 to 34, null, 1 to 36, null, null, 2 to 51, 2 to null, null, 3 to 100)
        val shown = perRevision.map { stars.offer(it?.first) to destroyed.offer(it?.second) }
        assertEquals(listOf(1 to 34, 1 to 34, 1 to 36, 1 to 36, 1 to 36, 2 to 51, 2 to 51, 2 to 51, 3 to 100), shown)
        val committed = BattleHudLatch<Boolean>()
        assertEquals(listOf(false, true, true, true), listOf(false, true, false, true).map { committed.offer(true.takeIf { _ -> it }) == true })
    }
    @Test fun `only a blocking coordinator error is a HUD row, so a failed send and its clearing receipt add and remove nothing`() {
        val failedSend = live().copy(error = "timeout")
        assertTrue(battleErrorLines(failedSend, null, null, createFailed = false).isEmpty())
        assertEquals(listOf("Battle recovery could not be saved."), battleErrorLines(failedSend.copy(error = "Battle recovery could not be saved.", blocked = true), null, null, false))
        assertEquals("Start, finish, speed and rally refusals still arrive through the repository line", listOf("raid clock is stale", "Choose buffs first"),
            battleErrorLines(failedSend, "raid clock is stale", "Choose buffs first", false))
        assertEquals(listOf("notice"), battleErrorLines(failedSend.copy(blocked = true), "refused", "notice", createFailed = true))
    }
}
