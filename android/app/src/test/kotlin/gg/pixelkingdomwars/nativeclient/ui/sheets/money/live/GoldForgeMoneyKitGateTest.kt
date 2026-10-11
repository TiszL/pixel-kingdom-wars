package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.*
import org.junit.Assert.*
import org.junit.Test

/** Lantern5f9b5138: a populated observation is not an accepted owner handoff. AUTHORED/UNRUN. */
class GoldForgeMoneyKitGateTest {
    private fun claim() = ClaimUi("17", null, null, null, null, null, MoneyStage.READY, null, false)
    private fun gems() = GemsUi("server rate", "17", "7", "23", "16", emptyList(), null, "3", "91",
        null, null, MoneyStage.READY, false, false, false)
    private fun closed(look: ForgePrimaryLook) {
        assertEquals(ForgeAction.NONE, look.action); assertEquals(CommandState.DISABLED, look.state)
        assertNotEquals(CommandState.BUSY, look.state)
    }
    @Test fun `populated READY claim is closed by default without invented loading`() {
        val ui = claim(); assertFalse(ui.actionsAllowed); closed(claimPrimaryLook(ui)); assertEquals(ClaimPhase.READY, ui.phase)
    }
    @Test fun `populated READY Gems is closed by default without invented loading`() {
        val ui = gems(); assertFalse(ui.actionsAllowed); closed(gemsPrimaryLook(ui)!!); assertEquals(GemsPhase.READY, ui.phase)
    }
    @Test fun `admitted claim preserves existing action and quantity`() {
        val look = claimPrimaryLook(claim().copy(actionsAllowed = true))
        assertEquals(ForgeAction.CLAIM, look.action); assertEquals(CommandState.ENABLED, look.state)
        assertEquals("17 KEEP to your wallet", look.sub)
    }
    @Test fun `admitted Gems preserves existing buy and exact wallet amount`() {
        val look = gemsPrimaryLook(gems().copy(actionsAllowed = true))!!
        assertEquals(ForgeAction.BUY, look.action); assertEquals(CommandState.ENABLED, look.state)
        assertEquals("paid with 7 KEEP from your wallet", look.sub)
    }
    @Test fun `saved claim is display only until original owner handoff is admitted`() {
        val ui = claim().copy(canResumeSaved = true); closed(claimPrimaryLook(ui))
        assertEquals(ForgeAction.CONTINUE, claimPrimaryLook(ui.copy(actionsAllowed = true)).action)
    }
    @Test fun `saved Gems is display only until original owner handoff is admitted`() {
        val ui = gems().copy(pendingRecovery = true); closed(gemsPrimaryLook(ui)!!)
        assertEquals(ForgeAction.CONTINUE, gemsPrimaryLook(ui.copy(actionsAllowed = true))!!.action)
    }
    @Test fun `refused claim retry cannot bypass a closed gate`() {
        val ui = claim().copy(stage = MoneyStage.FAILED, failure = MoneyFailure.REFUSED)
        closed(claimPrimaryLook(ui)); assertEquals(ForgeAction.RETRY, claimPrimaryLook(ui.copy(actionsAllowed = true)).action)
    }
    @Test fun `refused Gems retry cannot bypass a closed gate`() {
        val ui = gems().copy(stage = MoneyStage.FAILED, failure = MoneyFailure.REFUSED)
        closed(gemsPrimaryLook(ui)!!); assertEquals(ForgeAction.RETRY, gemsPrimaryLook(ui.copy(actionsAllowed = true))!!.action)
    }
    @Test fun `Gems failed-read retry also respects the owner gate`() {
        val ui = gems().copy(phase = GemsPhase.ERROR); closed(gemsPrimaryLook(ui)!!)
        assertEquals(ForgeAction.RETRY, gemsPrimaryLook(ui.copy(actionsAllowed = true))!!.action)
    }
    @Test fun `gating preserves actual loading evidence`() {
        assertEquals(CommandState.BUSY, claimPrimaryLook(claim().copy(phase = ClaimPhase.LOADING)).state)
        assertEquals(CommandState.BUSY, gemsPrimaryLook(gems().copy(phase = GemsPhase.LOADING))!!.state)
    }
    @Test fun `gating preserves sent receipt evidence without action`() {
        val c = claimPrimaryLook(claim().copy(stage = MoneyStage.SENT)); assertEquals(ForgeAction.NONE, c.action)
        assertEquals("IN YOUR WALLET", c.label)
        val g = gemsPrimaryLook(gems().copy(stage = MoneyStage.SENT))!!; assertEquals(ForgeAction.NONE, g.action)
        assertEquals("SENT", g.label)
    }
    @Test fun `Gems OFF stays without primary even when gate is open`() {
        assertNull(gemsPrimaryLook(gems().copy(phase = GemsPhase.OFF)))
        assertNull(gemsPrimaryLook(gems().copy(phase = GemsPhase.OFF, actionsAllowed = true)))
    }
    @Test fun `closed locked mint preserves its non-spending explanation and padlock`() {
        val ui = claim().copy(phase = ClaimPhase.LOCKED, lock = ClaimLockUi("server date", "server reason"))
        val look = claimPrimaryLook(ui)
        assertFalse(ui.actionsAllowed); assertEquals(CommandState.LOCKED, look.state)
        assertEquals(ForgeAction.EXPLAIN_LOCK, look.action); assertEquals("opens server date", look.sub)
    }

}
