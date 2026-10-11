package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkrFaucetFooter
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.skrFaucetFooter
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The devnet SKR faucet hands out test tokens through a wallet-signed transfer: it must never exist on mainnet, never
 * show an amount the server did not send (unknown is "…", not "0"), never hide a lost claim's recovery card, and its
 * CLAIM stays off with a player-facing reason until a claim owner is wired, so this lane can never start a transfer. */
class SkrFaucetLiveMapperTest {
    private val now = Instant.parse("2030-01-01T00:00:00Z").toEpochMilli()
    private val ready = SkrFaucetStatus(enabled = true, hasDeed = true, eligible = true, grantAmount = "1000000000")
    private fun input(status: SkrFaucetStatus? = ready, devnet: Boolean = true, balance: String? = "21240000000", decimals: Int? = 6,
        step: SkrClaimStep? = null, uncertain: Boolean = false, busy: Boolean = false) =
        SkrFaucetInput(devnet, status, balance, decimals, step, uncertain, busy)

    @Test fun `mainnet has no faucet route even when a status says eligible`() {
        assertNull(skrFaucetSheetLiveUi(input(devnet = false), now))
        assertNull("A lost claim cannot exist on mainnet either", skrFaucetSheetLiveUi(input(devnet = false, uncertain = true), now))
    }

    @Test fun `the server flag off removes the sheet`() {
        assertNull(skrFaucetSheetLiveUi(input(ready.copy(enabled = false)), now))
    }

    @Test fun `before the server answers the card and balance read unknown, never zero, and nothing can be pressed`() {
        val ui = skrFaucetSheetLiveUi(input(status = null, balance = null), now)!!
        assertNull(ui.faucet)
        assertEquals(UNKNOWN, ui.skr)
        assertEquals(SkrFaucetFooter.NONE, skrFaucetFooter(ui))
    }

    @Test fun `the grant and balance are the server's base units at the mint's decimals - no literal 1,000`() {
        val ui = skrFaucetSheetLiveUi(input(ready.copy(grantAmount = "2500000000")), now)!!
        assertEquals(FaucetUi.Ready("2,500"), ui.faucet)
        assertEquals("21,240", ui.skr)
        assertEquals(FaucetUi.Ready("1,000"), skrFaucetSheetLiveUi(input(), now)!!.faucet)
    }

    @Test fun `unknown decimals or grant read as an ellipsis, not as raw base units`() {
        val ui = skrFaucetSheetLiveUi(input(decimals = null), now)!!
        assertEquals(UNKNOWN, ui.skr)
        assertEquals(FaucetUi.Ready(UNKNOWN), ui.faucet)
        assertEquals(FaucetUi.Ready(UNKNOWN), skrFaucetSheetLiveUi(input(ready.copy(grantAmount = null)), now)!!.faucet)
    }

    @Test fun `CLAIM is a money action - drawn disabled with the not-open reason, never enabled by this lane`() {
        val ui = skrFaucetSheetLiveUi(input(), now)!!
        assertEquals(CommandState.DISABLED, ui.claimState)
        // Rewritten 2026-10-06 (design correction 1): the reason used to be the lane's "wiring pending: MS-M3", which is
        // drawn under CLAIM and shown on tap. Players must never read lane jargon, so the reason is the plain sentence.
        assertEquals(SKR_FAUCET_NOT_OPEN_IN_APP, ui.claimReason)
        assertFalse("No lane jargon reaches players", ui.claimReason!!.contains("MS-M3"))
        assertEquals("A claimable faucet shows CLAIM as an off button, not the live gold MoneyButton",
            SkrFaucetFooter.CLAIM_OFF, skrFaucetFooter(ui))
    }

    @Test fun `the CLAIM stub only explains why - it calls nothing that could start a transfer`() {
        val explained = mutableListOf<String>()
        var other = 0
        val on = skrFaucetLiveActions(onClose = { other++ }, onGetLand = { other++ }, onGoSeeker = { other++ }, onRecheck = { other++ },
            onExplain = { explained += it })
        on.onClaim()
        // Rewritten 2026-10-06 (design correction 1): the tap used to toast "wiring pending: MS-M3"; players must never
        // read lane jargon, so it explains with the plain not-open sentence.
        assertEquals(listOf(SKR_FAUCET_NOT_OPEN_IN_APP), explained)
        assertFalse(explained.single().contains("MS-M3"))
        assertEquals(0, other)
        on.onGetLand(); on.onRecheck()
        assertEquals("Navigation and the status read are passed through", 2, other)
    }

    @Test fun `no deed locks the card behind GET LAND, whatever else the status says`() {
        val ui = skrFaucetSheetLiveUi(input(ready.copy(hasDeed = false)), now)!!
        assertEquals(FaucetUi.NeedsDeed, ui.faucet)
        assertEquals(SkrFaucetFooter.GET_LAND, skrFaucetFooter(ui))
    }

    // The locked card's "n SKR a day" must be the server's grant at the mint's decimals, never a literal 1,000.
    @Test fun `the locked headline amount is the server's grant and unknown without decimals`() {
        assertEquals("2,500", skrFaucetSheetLiveUi(input(ready.copy(hasDeed = false, grantAmount = "2500000000")), now)!!.dailyAmount)
        assertEquals(UNKNOWN, skrFaucetSheetLiveUi(input(ready.copy(hasDeed = false), decimals = null), now)!!.dailyAmount)
        assertEquals(UNKNOWN, skrFaucetSheetLiveUi(input(status = null), now)!!.dailyAmount)
    }

    @Test fun `claimed today counts to the server's next time, and a stale time reads unknown instead of 0s`() {
        val claimed = ready.copy(eligible = false, nextEligibleAt = "2030-01-01T07:12:00Z")
        val ui = skrFaucetSheetLiveUi(input(claimed), now)!!
        assertEquals(FaucetUi.ClaimedToday("7h 12m"), ui.faucet)
        assertEquals(SkrFaucetFooter.TIMER, skrFaucetFooter(ui))
        assertEquals(FaucetUi.ClaimedToday(UNKNOWN),
            skrFaucetSheetLiveUi(input(claimed.copy(nextEligibleAt = "2029-12-31T23:00:00Z")), now)!!.faucet)
    }

    @Test fun `a paused or empty faucet says the server's reason and offers no button`() {
        val ui = skrFaucetSheetLiveUi(input(ready.copy(eligible = false, unavailableReason = "The test SKR store is empty.")), now)!!
        assertEquals(FaucetUi.Unavailable("The test SKR store is empty."), ui.faucet)
        assertEquals(SkrFaucetFooter.NONE, skrFaucetFooter(ui))
        assertEquals(FaucetUi.Unavailable(SKR_FAUCET_NOT_OPEN), skrFaucetSheetLiveUi(input(ready.copy(eligible = false)), now)!!.faucet)
    }

    @Test fun `a lost claim answer keeps the checking card even if a later read says the flag is off`() {
        val ui = skrFaucetSheetLiveUi(input(ready.copy(enabled = false), uncertain = true, busy = true), now)
        assertNotNull("The recovery surface must not disappear", ui)
        assertEquals(FaucetUi.Checking, ui!!.faucet)
        assertEquals(SkrFaucetFooter.RECHECK, skrFaucetFooter(ui))
        assertTrue(ui.checking)
    }

    @Test fun `a grant in flight shows the money sequence, not a fresh CLAIM`() {
        val pending = skrFaucetSheetLiveUi(input(ready.copy(eligible = false, pending = true)), now)!!
        assertEquals(FaucetUi.Claiming("1,000", MoneyStage.SENDING), pending.faucet)
        assertEquals(SkrFaucetFooter.CLAIM_MONEY, skrFaucetFooter(pending))
        val signing = skrFaucetSheetLiveUi(input(step = SkrClaimStep.SIGNING), now)!!
        assertEquals(FaucetUi.Claiming("1,000", MoneyStage.CHECK_WALLET), signing.faucet)
        assertFalse("A claim in flight is never offered as claimable again", signing.faucet is FaucetUi.Ready)
    }
}
