package gg.pixelkingdomwars.nativeclient.ui

import org.junit.Assert.*
import org.junit.Test

/** The one dialog in front of every KEEP spend (web KeepSpendConfirm.tsx + lib/keepConfirm.ts): asks by
 * default, an unreadable preference fails SAFE, CANCEL posts nothing, and the opt-out is applied on CONFIRM
 * only — a refused purchase must never disarm the guard on the way out. */
class KeepSpendConfirmTest {
    private class Memory(var stored: String? = null) : KeepConfirmPreference {
        var writes = 0
        override fun on() = keepConfirmOn(stored)
        override fun set(on: Boolean) { stored = if (on) "1" else "0"; writes++ }
    }

    @Test fun `the preference asks unless the stored flag is exactly the opt-out value`() {
        assertTrue(keepConfirmOn(null)); assertTrue(keepConfirmOn("1")); assertTrue(keepConfirmOn("")); assertTrue(keepConfirmOn("false"))
        assertFalse(keepConfirmOn("0"))
    }
    @Test fun `confirm runs the spend once and cancel runs nothing`() {
        val preference = Memory(); val state = KeepSpendConfirmState(preference)
        var spent = 0
        state.confirm(KeepSpendIntent("2500", "UPGRADE VEX TO LEVEL 2", immediate = false) { spent++ })
        assertNotNull("The dialog is showing, nothing was posted", state.pending); assertEquals(0, spent)
        state.cancel(); assertNull(state.pending); assertEquals(0, spent); assertEquals(0, preference.writes)
        state.confirm(KeepSpendIntent("7", "RECOVER VEX") { spent++ })
        state.accept(); assertEquals(1, spent); assertNull(state.pending)
        state.accept(); assertEquals("A second accept with nothing pending spends nothing", 1, spent)
    }
    @Test fun `don't ask again is applied on confirm only and then skips the dialog`() {
        val preference = Memory(); val state = KeepSpendConfirmState(preference)
        var spent = 0
        state.confirm(KeepSpendIntent("3", "FINISH TRAINING THE WHOLE QUEUE") { spent++ })
        state.optOut = true; state.cancel()
        assertTrue("Cancelling with the switch on never disarms the guard", preference.on()); assertEquals(0, preference.writes)
        state.confirm(KeepSpendIntent("3", "FINISH TRAINING THE WHOLE QUEUE") { spent++ })
        assertFalse("The switch resets for every new dialog", state.optOut)
        state.optOut = true; state.accept()
        assertEquals(1, spent); assertFalse(preference.on()); assertEquals("0", preference.stored)
        state.confirm(KeepSpendIntent("3", "FINISH TRAINING THE WHOLE QUEUE") { spent++ })
        assertNull("Opted out: the spend runs at once", state.pending); assertEquals(2, spent)
    }
    @Test fun `economy review cannot inherit speedup opt-out or disable its next review`() {
        val preference = Memory("0"); val state = KeepSpendConfirmState(preference); var spent = 0
        val conversion = KeepSpendIntent("10", "CONVERT AT THE ACCEPTED RATE", immediate = false, alwaysReview = true) { spent++ }
        state.confirm(conversion)
        assertNotNull("Review is required even when earlier speedups opted out", state.pending); assertEquals(0, spent)
        state.cancel(); assertEquals(0, spent)
        state.confirm(conversion); state.optOut = true; state.accept(); state.accept()
        assertEquals(1, spent); assertEquals(0, preference.writes)
        state.confirm(conversion); assertNotNull(state.pending); assertEquals(1, spent)
    }

}
