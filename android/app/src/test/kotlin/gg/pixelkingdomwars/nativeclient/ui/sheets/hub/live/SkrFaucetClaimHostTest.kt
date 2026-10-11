package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.FakeApiClient
import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.data.SkrFaucetBounds
import gg.pixelkingdomwars.nativeclient.data.SkrFaucetBoundsCheck
import gg.pixelkingdomwars.nativeclient.data.SkrFaucetJournal
import gg.pixelkingdomwars.nativeclient.data.SkrFaucetRepository
import gg.pixelkingdomwars.nativeclient.data.SkrFaucetState
import gg.pixelkingdomwars.nativeclient.model.SkrFaucetGrant
import gg.pixelkingdomwars.nativeclient.signedIn
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.faucetLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.faucetRowLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkrFaucetFooter
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkrFaucetSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.skrFaucetFooter
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import java.time.Instant
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * WHY: in a pinned test build the faucet sheet is the owner's showcase, and it draws the server's verdict, never a
 * guess. Only a faucet the server calls open (or the player's own reserved grant awaiting their signature) may draw the
 * live gold CLAIM; every refusal keeps the kit's copy for that state (GET LAND, Claimed · next in, the paused/unset
 * sentences) with no live CLAIM; a lost answer keeps the checking card; amounts are the server's grant at the pinned
 * decimals, never a literal; and with no cadence to poll at, a submitted claim offers CHECK AGAIN instead of an endless
 * "Sending". Server bodies are the fixture-derived P5 vectors.
 */
class SkrFaucetClaimHostTest {
    private val api = Json.parseToJsonElement(requireNotNull(javaClass.getResourceAsStream("/skr-faucet-api-vectors.json"))
        .bufferedReader().use { it.readText() }).jsonObject
    private fun vector(name: String) = api.getValue(name).jsonObject
    private val grant = SkrFaucetGrant.from(vector("claim").getValue("grant").jsonObject)
    private val polling = SkrFaucetBounds(5000, "1000", 20)
    private val now = Instant.parse("2026-10-06T12:00:00Z").toEpochMilli()

    /** The repository's state after one status read of [status]. */
    private fun after(status: JsonObject, bounds: SkrFaucetBounds = polling): SkrFaucetState = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val http = FakeApiClient()
        http.onGet("/devnet-skr-faucet/status") { status }
        val repo = SkrFaucetRepository(session, holder, http, SkrFaucetJournal(MemoryStore(), session.wallet, session.origin, "devnet"),
            { SkrIdentity(grant.mint, grant.decimals) }, { bounds }, { "11111111-1111-4111-8111-111111111111" },
            { _, _, _ -> error("Mapping never signs") }, {})
        repo.refresh(); repo.state.value
    }
    private fun reason(name: String, enabled: Boolean = true) =
        JsonObject(vector("status") + mapOf("reason" to JsonPrimitive(name), "eligible" to JsonPrimitive(false), "enabled" to JsonPrimitive(enabled)))
    private fun sheet(state: SkrFaucetState, land: Boolean? = true, check: SkrFaucetBoundsCheck? = SkrFaucetBoundsCheck.KNOWN,
        bounds: SkrFaucetBounds? = polling, step: SkrClaimStep? = null, reads: Int = 1): SkrFaucetSheetUi? =
        skrFaucetSheetLiveUi(skrFaucetClaimInput(land, state, check, bounds, grant.decimals, step, reads), now)

    @Test fun `only an open faucet or the player's own grant awaiting their signature draws the live gold CLAIM`() {
        for (name in listOf("status", "statusSignRequired", "statusPending")) {
            val ui = sheet(after(vector(name)))!!
            assertEquals(name, FaucetUi.Ready("1,000"), ui.faucet)
            assertEquals(name, CommandState.ENABLED, ui.claimState); assertNull(name, ui.claimReason)
            assertEquals(name, SkrFaucetFooter.CLAIM_MONEY, skrFaucetFooter(ui))
            assertEquals("CLAIM 1,000", faucetLook(ui.faucet!!, ui.dailyAmount)!!.claimLabel)
        }
        val refused = mapOf(
            "deed_required" to FaucetUi.NeedsDeed,
            "unavailable" to FaucetUi.Unavailable(SKR_FAUCET_PAUSED),
            "unconfigured" to FaucetUi.Unavailable(SKR_FAUCET_UNCONFIGURED),
            "select_base" to FaucetUi.Unavailable(SKR_FAUCET_SELECT_BASE),
            "retired_deed" to FaucetUi.Unavailable(SKR_FAUCET_RETIRED_DEED),
            "deed_unavailable" to FaucetUi.Unavailable(SKR_FAUCET_DEED_UNCHECKED),
            "future_reason" to FaucetUi.Unavailable(SKR_FAUCET_NOT_OPEN))
        for ((name, expected) in refused) {
            val ui = sheet(after(reason(name)))!!
            assertEquals(name, expected, ui.faucet); assertNotEquals(name, CommandState.ENABLED, ui.claimState)
            assertNotEquals(name, SkrFaucetFooter.CLAIM_MONEY, skrFaucetFooter(ui))
        }
        // Server-authoritative deed rule (owner N-045, 2026-10-06: the QA chain lane serves deedless claims): a landless
        // phone with an `ok` status gets the live CLAIM; only the server's `deed_required` locks the card.
        assertEquals("No land locally, `ok` from the server: CLAIM", FaucetUi.Ready("1,000"), sheet(after(vector("status")), land = false)!!.faucet)
        assertEquals("Land locally, `deed_required` from the server: GET LAND", FaucetUi.NeedsDeed, sheet(after(reason("deed_required")), land = true)!!.faucet)
        assertNull("The server's faucet flag off: no sheet", sheet(after(reason("disabled", enabled = false))))
    }

    @Test fun `a signed claim shows Sending while the cadence polls, CHECK AGAIN without one, and Claimed once it arrived`() {
        val sending = sheet(after(vector("statusSubmitted")))!!
        assertEquals(FaucetUi.Claiming("1,000", MoneyStage.SENDING), sending.faucet)
        assertNotEquals(CommandState.ENABLED, sending.claimState)
        val unpolled = SkrFaucetBounds(null, "1000")
        val checking = sheet(after(vector("statusSubmitted"), unpolled), bounds = unpolled)!!
        assertEquals(FaucetUi.Checking, checking.faucet); assertEquals(SkrFaucetFooter.RECHECK, skrFaucetFooter(checking))
        val claimed = sheet(after(vector("statusClaimed")))!!
        assertTrue(claimed.faucet is FaucetUi.ClaimedToday); assertEquals(SkrFaucetFooter.TIMER, skrFaucetFooter(claimed))
        // A grant the faucet could not complete is not "Claimed": it says so and offers nothing.
        val today = vector("statusClaimed").getValue("today").jsonObject
        val failed = JsonObject(vector("statusClaimed") + ("today" to JsonObject(today + mapOf("status" to JsonPrimitive("failed"),
            "error" to JsonPrimitive("max_attempts"), "sentAt" to JsonNull))))
        assertEquals(FaucetUi.Unavailable(SKR_FAUCET_TODAY_FAILED), sheet(after(failed))!!.faucet)
    }

    @Test fun `the wallet step and the arrival use the kit's money sequence`() {
        val open = after(vector("status"))
        assertEquals(FaucetUi.Claiming("1,000", MoneyStage.CHECK_WALLET), sheet(open, step = SkrClaimStep.SIGNING)!!.faucet)
        assertEquals(FaucetUi.Claiming("1,000", MoneyStage.SENT), sheet(open, step = SkrClaimStep.SENT)!!.faucet)
    }

    @Test fun `a lost claim answer keeps the checking card and never offers a fresh CLAIM`() {
        val lost = after(vector("status")).copy(uncertain = true)
        val ui = sheet(lost)!!
        assertEquals(FaucetUi.Checking, ui.faucet); assertEquals(SkrFaucetFooter.RECHECK, skrFaucetFooter(ui))
        assertNotEquals(CommandState.ENABLED, ui.claimState)
    }

    @Test fun `unknown or unconfirmable faucet numbers read unknown and are never claimable`() {
        val empty = SkrFaucetState()
        assertNull("Still resolving: the card reads …", sheet(empty, check = null, bounds = null)!!.faucet)
        assertNull("Resolved but not read yet", sheet(empty, reads = 0)!!.faucet)
        val unconfirmed = sheet(empty, check = SkrFaucetBoundsCheck.UNCONFIRMED, bounds = null)!!
        assertEquals(FaucetUi.Unavailable(SKR_FAUCET_AMOUNT_UNKNOWN), unconfirmed.faucet); assertEquals(UNKNOWN, unconfirmed.dailyAmount)
        assertEquals(FaucetUi.Unavailable(SKR_FAUCET_TOKEN_MISMATCH), sheet(empty, check = SkrFaucetBoundsCheck.MISMATCH, bounds = null)!!.faucet)
        assertEquals("Landless with no status: the real reason, never an invented deed verdict", FaucetUi.Unavailable(SKR_FAUCET_AMOUNT_UNKNOWN),
            sheet(empty, land = false, check = SkrFaucetBoundsCheck.UNCONFIRMED, bounds = null)!!.faucet)
        assertEquals("A status read that failed says the repository's reason", FaucetUi.Unavailable("Faucet unavailable."),
            sheet(empty.copy(error = "Faucet unavailable."))!!.faucet)
        // Even with an open status, CLAIM stays off until the faucet's numbers are confirmed.
        assertNotEquals(CommandState.ENABLED, sheet(after(vector("status")), check = SkrFaucetBoundsCheck.UNCONFIRMED)!!.claimState)
    }

    @Test fun `the Profile row of a pinned build invites the player in, an unpinned build is unchanged`() {
        assertEquals(FaucetUi.Unavailable(SKR_FAUCET_OPEN_TO_CHECK), skrFaucetLocalState(devnet = true, landOwned = true, claimOpen = true))
        assertEquals(SKR_FAUCET_OPEN_TO_CHECK, faucetRowLine(skrFaucetLocalState(true, true, claimOpen = true)!!))
        assertEquals(FaucetUi.Unavailable(SKR_FAUCET_NOT_OPEN_IN_APP), skrFaucetLocalState(devnet = true, landOwned = true))
        // The pinned build's row never decides the deed rule locally: the sheet reads the server (deedless lanes say `ok`).
        assertEquals(FaucetUi.Unavailable(SKR_FAUCET_OPEN_TO_CHECK), skrFaucetLocalState(devnet = true, landOwned = false, claimOpen = true))
        assertEquals("unpinned: the local deed rule as before", FaucetUi.NeedsDeed, skrFaucetLocalState(devnet = true, landOwned = false))
        assertEquals(FaucetUi.Hidden, skrFaucetLocalState(devnet = false, landOwned = true, claimOpen = true))
    }

    @Test fun `a CLAIM tap reaches the claim owner only where one is passed`() {
        val said = mutableListOf<String>(); var claims = 0
        skrFaucetLiveActions({}, {}, {}, {}, { said += it }, onClaim = { claims++ }).onClaim()
        assertEquals(1, claims); assertTrue(said.isEmpty())
        skrFaucetLiveActions({}, {}, {}, {}, { said += it }).onClaim()
        assertEquals(listOf(SKR_FAUCET_NOT_OPEN_IN_APP), said); assertEquals(1, claims)
    }
}
