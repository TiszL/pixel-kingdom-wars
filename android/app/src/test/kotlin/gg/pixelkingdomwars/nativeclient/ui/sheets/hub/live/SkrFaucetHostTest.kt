package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.data.EconomyState
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.faucetLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkrFaucetFooter
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.skrFaucetFooter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * In every build without the pinned devnet SKR identity (production above all; the pinned test build is covered by
 * SkrFaucetClaimHostTest) the mounted SKR faucet sheet has no claim owner, so it may only show states it can stand behind: mainnet never shows test tokens,
 * a landless player is sent to land first, a landed player is told plainly that claiming is not open here, and nothing
 * can ever look claimable or start a transfer. Its numbers are the wallet read's and the catalogue's, and a routine
 * refresh never blanks an amount already shown.
 */
class SkrFaucetHostTest {
    private val catalogue = json("""{"constants":{"SKR_FAUCET":{"devnet":{"pollMs":5000,"grantSkr":2500}}}}""")
    private fun funds(skr: String?) = WalletFunds(sol = "0.84", tokens = mapOf("SKR" to skr, "KEEP" to "312.5"), asOf = 1L)

    // D153.275: test tokens are unreachable on mainnet, whatever the account says about land.
    @Test fun `mainnet has no faucet whatever the land, and the host draws nothing`() {
        assertEquals(FaucetUi.Hidden, skrFaucetLocalState(devnet = false, landOwned = true))
        assertEquals(FaucetUi.Hidden, skrFaucetLocalState(devnet = false, landOwned = false))
        assertEquals(FaucetUi.Hidden, skrFaucetLocalState(devnet = false, landOwned = null))
        assertNull("No sheet: the host closes instead of drawing", skrFaucetHostUi(false, true, funds("240"), catalogue))
    }

    // Unknown land must not guess either way: no padlock that may be wrong, no button, "…" in the card.
    @Test fun `unknown land reads unknown and offers no button`() {
        assertNull(skrFaucetLocalState(devnet = true, landOwned = null))
        val ui = skrFaucetHostUi(true, null, null, catalogue)!!
        assertNull(ui.faucet)
        assertEquals(SkrFaucetFooter.NONE, skrFaucetFooter(ui))
    }

    // The faucet requires a minted Kingdom Deed: a landless player's only door is GET LAND (the land gate).
    @Test fun `a landless player sees the locked card with GET LAND and the catalogue amount`() {
        assertEquals(FaucetUi.NeedsDeed, skrFaucetLocalState(devnet = true, landOwned = false))
        val ui = skrFaucetHostUi(true, false, funds("240"), catalogue)!!
        assertEquals(SkrFaucetFooter.GET_LAND, skrFaucetFooter(ui))
        assertEquals("2,500", ui.dailyAmount)
        assertEquals("The locked headline is the catalogue's grant, never a literal 1,000",
            "2,500 SKR a day", faucetLook(ui.faucet!!, ui.dailyAmount)!!.headline)
        assertEquals("DAILY TEST SKR", ui.frame.title)
        assertEquals(SheetSize.HALF, ui.frame.size)
    }

    // No claim owner can be constructed: a landed player reads why, and no CLAIM that cannot run is ever drawn.
    @Test fun `a landed player is told claiming is not open here and is never offered CLAIM`() {
        assertEquals(FaucetUi.Unavailable(SKR_FAUCET_NOT_OPEN_IN_APP), skrFaucetLocalState(devnet = true, landOwned = true))
        val ui = skrFaucetHostUi(true, true, funds("240"), catalogue)!!
        assertEquals(SkrFaucetFooter.NONE, skrFaucetFooter(ui))
        assertEquals(SKR_FAUCET_NOT_OPEN_IN_APP, faucetLook(ui.faucet!!)!!.line)
        assertEquals(CommandState.DISABLED, ui.claimState)
        assertEquals(SKR_FAUCET_NOT_OPEN_IN_APP, ui.claimReason)
        assertFalse("Players never read lane jargon", SKR_FAUCET_NOT_OPEN_IN_APP.contains("MS-"))
        assertFalse("Public wording never sells free", SKR_FAUCET_NOT_OPEN_IN_APP.contains("free", ignoreCase = true))
    }

    // Without a claim owner, no input may produce a claimable, in-flight or lost-claim state.
    @Test fun `no cluster or land answer ever produces a claimable or in-flight state`() {
        for (devnet in listOf(true, false)) for (land in listOf(true, false, null)) {
            val state = skrFaucetLocalState(devnet, land)
            assertFalse("devnet=$devnet land=$land", state is FaucetUi.Ready)
            assertFalse("devnet=$devnet land=$land", state is FaucetUi.Claiming)
            assertFalse("devnet=$devnet land=$land", state == FaucetUi.Checking)
        }
    }

    // Every number is the server's or the catalogue's: SKR from the wallet read, the grant from SKR_FAUCET; unknown is "…".
    @Test fun `the SKR readout and the daily grant come from the wallet read and the catalogue, unknown is an ellipsis`() {
        assertEquals("21,240", skrFaucetHostUi(true, true, funds("21240"), catalogue)!!.skr)
        val unknown = skrFaucetHostUi(true, true, null, null)!!
        assertEquals(UNKNOWN, unknown.skr)
        assertEquals(UNKNOWN, unknown.dailyAmount)
        assertEquals("A wallet read without SKR is unknown, not 0", UNKNOWN, skrFaucetHostUi(true, true, funds(null), catalogue)!!.skr)
        assertEquals("A catalogue without the faucet policy has no amount", UNKNOWN, skrFaucetDailyAmount(json("""{"constants":{}}""")))
    }

    // A routine refresh must not blank data already shown; only a successful wallet read replaces it.
    @Test fun `a failed or empty wallet refresh keeps the last SKR readout`() {
        val shown = funds("240")
        assertEquals(shown, skrFaucetKeptFunds(shown, EconomyState(errors = mapOf("/wallet/balances" to "Connection interrupted."))))
        assertEquals("A failed read never wins, even with older funds still in state", shown,
            skrFaucetKeptFunds(shown, EconomyState(wallet = funds("0"), errors = mapOf("/wallet/balances" to "Unavailable on this server."))))
        assertEquals(shown, skrFaucetKeptFunds(shown, EconomyState(wallet = null)))
        val fresh = funds("1240")
        assertEquals(fresh, skrFaucetKeptFunds(shown, EconomyState(wallet = fresh)))
        assertEquals("Another page's failure does not hide a good wallet read", fresh,
            skrFaucetKeptFunds(shown, EconomyState(wallet = fresh, errors = mapOf("/balances" to "Connection interrupted."))))
    }

    // CLAIM and CHECK AGAIN must never reach a repository (no transfer can start); GET LAND, GO and close are real doors.
    @Test fun `claim and check again only explain why, the doors pass through`() {
        val said = mutableListOf<String>()
        val doors = mutableListOf<String>()
        val on = skrFaucetHostActions(onClose = { doors += "close" }, onGetLand = { doors += "land" }, onGoSeeker = { doors += "seeker" }) { said += it }
        on.onClaim(); on.onRecheck()
        assertEquals(listOf(SKR_FAUCET_NOT_OPEN_IN_APP, SKR_FAUCET_NOT_OPEN_IN_APP), said)
        assertTrue("Neither tap navigates or closes", doors.isEmpty())
        on.onGetLand(); on.onGoSeeker(); on.onClose()
        assertEquals(listOf("land", "seeker", "close"), doors)
        assertEquals(2, said.size)
    }
}
