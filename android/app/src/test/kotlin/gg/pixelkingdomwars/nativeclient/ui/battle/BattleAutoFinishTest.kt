package gg.pixelkingdomwars.nativeclient.ui.battle

import org.junit.Assert.*
import org.junit.Test

/** The owner waited 20–30 s for VICTORY after 100% destruction because only CHECK RESULT posted FINISH.
 * The guard must post once at 100%, never repeat on every recomposition, and still post at the clock end. */
class BattleAutoFinishTest {
    private fun BattleAutoFinish.at(destroyed: Int?, due: Boolean = false, running: Boolean = true, settled: Boolean = false, ready: Boolean = true) =
        shouldFinish(destroyed, running, settled, ready, due)

    @Test fun `exactly one automatic finish per raid at full destruction`() {
        val guard = BattleAutoFinish()
        assertFalse(guard.at(0)); assertFalse(guard.at(99)); assertFalse(guard.at(null))
        assertTrue(guard.at(100))
        repeat(5) { assertFalse("recompositions must not repeat the POST", guard.at(100)) }
        assertFalse(guard.at(100, settled = true))
    }

    @Test fun `a request refused as not due is asked again exactly once when the clock is due`() {
        val guard = BattleAutoFinish()
        assertTrue(guard.at(100))
        assertFalse(guard.at(100))
        assertTrue("the due clock owns its own single request", guard.at(100, due = true))
        assertFalse(guard.at(100, due = true))
        assertFalse(guard.at(100, due = false))
    }

    @Test fun `no troops left below full destruction waits for the clock and never finishes a settled staging or offline raid`() {
        val guard = BattleAutoFinish()
        assertFalse(guard.at(60)); assertFalse(guard.at(60, running = false, due = true))
        assertFalse(guard.at(60, settled = true, due = true))
        assertFalse("offline or blocked: keep the request for a live connection", guard.at(100, ready = false))
        assertTrue("readiness returning still owes the one request", guard.at(100))
        assertTrue(guard.at(60, due = true))
        assertFalse(guard.at(60, due = true))
    }
}
