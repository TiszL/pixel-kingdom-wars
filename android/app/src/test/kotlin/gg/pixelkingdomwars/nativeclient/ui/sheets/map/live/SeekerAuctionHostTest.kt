package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.data.SeekerAuctionAttempt
import gg.pixelkingdomwars.nativeclient.data.SeekerAuctionKind
import gg.pixelkingdomwars.nativeclient.data.SeekerAuctionNotice
import gg.pixelkingdomwars.nativeclient.data.SeekerAuctionStage
import gg.pixelkingdomwars.nativeclient.data.SeekerAuctionState
import gg.pixelkingdomwars.nativeclient.data.SeekerAuctionTarget
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionConfig
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionSourcedRoundView
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionSpot
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MoneyFailureUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SearchKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SearchRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SpotFilter
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.moneyNote
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Seeker auction host (plan onchain-client-reach.md §5.4 S-E). The owner bids, gets outbid, withdraws and sees the won
 * celebration live on devnet test SKR in front of an audience: a money stage on the wrong spot, a BID offered over a step
 * whose outcome is still unknown, a Seal confirmed after the rounds moved, or a celebration without a settled round would
 * each be a visible lie about money. These pin the host's own decisions; the amounts and wording are the mappers' (tested
 * in SeekerAuctionMappersTest).
 */
class SeekerAuctionHostTest {
    private val other = "11111111111111111111111111111113"
    private val config = SeekerAuctionConfig(programId = "11111111111111111111111111111115", address = "11111111111111111111111111111114",
        mint = "11111111111111111111111111111116", prizeOwner = other, prizeAta = other, decimals = 6, openingBidRaw = "7000000",
        firstOperatingStart = "345600", termSec = "259200", auctionSec = "1800", graceSec = "600")

    /** Round 0's window is [343800, 345600); its term runs to 604800. */
    private val nowOpen = 344_700L
    private val afterWindow = 400_000L

    private fun row(spot: Int, high: String = "0", leader: String? = null, yours: String = "0", settled: Boolean = false) =
        SeekerAuctionSpot(spot = spot, spotClass = if (spot == 0) "king" else "regular", realmMask = 15, opened = true,
            highBidRaw = high, highBidder = leader, settled = settled, yourBidRaw = yours, refundable = yours != "0" && leader != WALLET)

    private fun view(spots: List<SeekerAuctionSpot> = (0..3).map { row(it) }, now: Long = nowOpen, source: String = "chain") =
        SeekerAuctionSourcedRoundView(version = 1, source = source, chainUnixTime = now.toString(), walletSkrRaw = "50000000",
            wallet = WALLET, observedSlot = "9", round = "0", biddingRound = "0", admissionPaused = false, config = config,
            auctionStart = "343800", auctionEnd = "345600", operatingStart = "345600", operatingEnd = "604800",
            openedCount = spots.count { it.opened }, completedCount = spots.count { it.settled },
            winnerCount = spots.count { it.settled && it.highBidder != null }, completedAt = null, spots = spots)

    private fun saved(kind: SeekerAuctionKind, spot: Int, signature: String? = "5".repeat(88)) = SeekerAuctionAttempt(
        "00000000-0000-4000-8000-000000000001", kind, "0", spot, if (kind == SeekerAuctionKind.BID) "8000000" else null,
        "11111111111111111111111111111117", "100", signature)

    private fun acting(kind: SeekerAuctionKind, spot: Int, stage: SeekerAuctionStage, notice: SeekerAuctionNotice? = null) =
        SeekerAuctionState(action = SeekerAuctionTarget(kind, "0", spot), stage = stage, notice = notice)

    /** Outbid on Spot 2 (index 1): 8 SKR of yours held under another kingdom's 9 SKR. */
    private val outbid = view(listOf(row(0), row(1, "9000000", other, "8000000"), row(2), row(3)))

    // WHY: the repository runs one bid or withdrawal at a time; its stage must light only the spot, round and button it
    // belongs to, or the owner sees "Check wallet" on a spot he never bid on.
    @Test fun `a step in flight shows its stage only on its own spot, round and button`() {
        val state = acting(SeekerAuctionKind.BID, 1, SeekerAuctionStage.CHECK_WALLET)
        val here = seekerSpotMoney(state, "0", 1)
        assertEquals(MoneyStage.CHECK_WALLET, here.bid)
        assertEquals(MoneyStage.READY, here.withdraw)
        assertNull("a step plainly in flight draws no checking line", here.failure)
        assertEquals(MoneyStage.READY, seekerSpotMoney(state, "0", 2).bid)
        assertEquals("the same spot of another round is another auction", MoneyStage.READY, seekerSpotMoney(state, "1", 1).bid)
    }

    // WHY: a saved step that may have reached the chain must never be offered as a fresh BID (that would ask the wallet
    // twice for one intent); it reads as Sending with the non-authoritative checking line.
    @Test fun `a saved unresolved step reads as checking and is never offered as a fresh BID`() {
        val money = seekerSpotMoney(SeekerAuctionState(pending = listOf(saved(SeekerAuctionKind.BID, 1))), "0", 1)
        assertEquals(MoneyStage.SENDING, money.bid)
        assertEquals(MoneyFailureUi("bid", authoritative = false), money.failure)
        assertEquals("Checking whether the bid went through.", moneyNote(true, money.failure!!.action, money.failure!!.authoritative))
        val withdrawal = seekerSpotMoney(SeekerAuctionState(pending = listOf(saved(SeekerAuctionKind.WITHDRAW, 1))), "0", 1)
        assertEquals(MoneyStage.SENDING, withdrawal.withdraw)
        assertEquals(MoneyStage.READY, withdrawal.bid)
        assertEquals("withdrawal", withdrawal.failure?.action)
    }

    // WHY: only the repository's CHECKING notice (the wallet answered but no finality yet) is uncertain; Sending without it is
    // the ordinary money sequence, and a refusal is RETRY, never "checking".
    @Test fun `the checking line appears only once the repository says the outcome is uncertain`() {
        assertNull(seekerSpotMoney(acting(SeekerAuctionKind.BID, 1, SeekerAuctionStage.SENDING), "0", 1).failure)
        assertNotNull(seekerSpotMoney(acting(SeekerAuctionKind.BID, 1, SeekerAuctionStage.SENDING, SeekerAuctionNotice.CHECKING), "0", 1).failure)
        val refused = seekerSpotMoney(acting(SeekerAuctionKind.BID, 1, SeekerAuctionStage.FAILED, SeekerAuctionNotice.NOTHING_SENT), "0", 1)
        assertEquals(MoneyStage.FAILED, refused.bid)
        assertNull(refused.failure)
    }

    // WHY: SENT must come only from the repository (after the finalized receipt and the refreshed round), and WITHDRAW must stay
    // hidden where nothing is refundable whatever stage is left over.
    @Test fun `the spot sheet carries the repository stage into BID and WITHDRAW of that spot only`() {
        val failedWithdraw = seekerHostSpotUi(acting(SeekerAuctionKind.WITHDRAW, 1, SeekerAuctionStage.FAILED).copy(current = outbid),
            1, nowOpen, null, emptyMap())
        assertEquals(MoneyStage.FAILED, failedWithdraw.withdraw)
        assertEquals(MoneyStage.READY, failedWithdraw.bidMoney)
        assertNotNull("outbid keeps the RAISE stepper", failedWithdraw.stepper)
        val sent = seekerHostSpotUi(acting(SeekerAuctionKind.BID, 1, SeekerAuctionStage.SENT).copy(current = outbid), 1, nowOpen, null, emptyMap())
        assertEquals(MoneyStage.SENT, sent.bidMoney)
        assertEquals(MoneyStage.READY, sent.withdraw)
        val nothingHeld = seekerHostSpotUi(acting(SeekerAuctionKind.WITHDRAW, 2, SeekerAuctionStage.SENT).copy(current = outbid), 2, nowOpen,
            null, emptyMap())
        assertNull(nothingHeld.withdraw)
    }

    // WHY: before the first read the sheet must say it is checking, never show a blank card or an invented amount.
    @Test fun `an unread round draws the checking sheet with no amounts`() {
        val ui = seekerHostSpotUi(SeekerAuctionState(), 6, 0L, null, emptyMap())
        assertTrue(ui.loading)
        assertEquals(7, ui.spot.spotNo)
        assertNull(ui.spot.highBid); assertNull(ui.spot.yourBid); assertNull(ui.stepper)
    }

    // WHY: the island search is the only way to a spot until the scene exists; it must find spot numbers as typed.
    @Test fun `the spot search matches numbers by prefix and keeps only digits`() {
        assertEquals("42", seekerSpotQuery(" 4a2\n"))
        val twelve = view((0..11).map { row(it) })
        val titles = seekerSpotSearchRows("1", SpotFilter.ALL, twelve, null, nowOpen).map { it.title }
        assertEquals(listOf("Spot 1", "Spot 10", "Spot 11", "Spot 12"), titles)
        assertTrue(seekerSpotSearchRows("13", SpotFilter.ALL, twelve, null, nowOpen).isEmpty())
    }

    // WHY: with an empty query the owner should land on his own spots first, and GO must open exactly the row tapped.
    @Test fun `an empty search lists your spots first and every row opens its own spot`() {
        val v = view(listOf(row(0), row(1), row(2, "8000000", WALLET, "8000000"), row(3)))
        val rows = seekerSpotSearchRows("", SpotFilter.ALL, v, null, nowOpen)
        assertEquals(listOf("Spot 3", "Spot 1", "Spot 2", "Spot 4"), rows.map { it.title })
        assertEquals(listOf(2, 0, 1, 3), rows.map { seekerSearchSpot(it) })
        assertEquals("Seeker Island · you lead", rows[0].sub)
        assertEquals("Seeker Island · King · bidding open", rows[1].sub)
        assertNull(seekerSearchSpot(SearchRowUi("k1", SearchKind.KINGDOM, "ui_portrait_keep_t3", "Kinmar", "Frostveil")))
        assertNull(seekerSearchSpot(SearchRowUi("seeker/x", SearchKind.SPOT, "site:seeker-available", "Spot x", "")))
    }

    // WHY: the YOU HERE cards open the search with that filter; MINE must be only operating wins and BIDS only escrow still
    // in play, the same rules the panel counts.
    @Test fun `MINE and BIDS keep only operating wins and unsettled escrow`() {
        val ended = view(listOf(row(0, "9000000", WALLET, "9000000", settled = true), row(1, "8000000", other, "7000000"),
            row(2, "8000000", WALLET, "8000000"), row(3, settled = true)), now = afterWindow)
        assertEquals(listOf("Spot 1"), seekerSpotSearchRows("", SpotFilter.MINE, ended, null, afterWindow).map { it.title })
        assertEquals(listOf("Spot 2", "Spot 3"), seekerSpotSearchRows("", SpotFilter.BIDS, ended, null, afterWindow).map { it.title })
        assertTrue("a term that ended is no longer yours", seekerSpotSearchRows("", SpotFilter.MINE, ended, null, 604_800L).isEmpty())
    }

    // WHY: a routine refresh or a failed read must never show an empty list as if there were no spots.
    @Test fun `the search waits for the first read and shows the danger line when it failed`() {
        val waiting = seekerSpotSearchUi("", SpotFilter.ALL, SeekerAuctionState(), 0L)
        assertTrue(waiting.busy); assertNull(waiting.error); assertTrue(waiting.spotsOnly)
        val failed = seekerSpotSearchUi("", SpotFilter.ALL, SeekerAuctionState(readFailed = true), 0L)
        assertFalse(failed.busy); assertEquals("Can't reach the auction", failed.error)
        val kept = seekerSpotSearchUi("", SpotFilter.BIDS, SeekerAuctionState(current = outbid, readFailed = true), nowOpen)
        assertNull("a failed refresh keeps the rows already read", kept.error)
        assertEquals("MY BIDS", kept.sections.single().title)
        assertEquals(listOf("Spot 2"), kept.sections.single().rows.map { it.title })
    }

    // WHY: the wallet must only ever be asked for what the Seal showed; if another kingdom raises, the window closes or the
    // escrow is already back, the confirm is refused and the player reviews again.
    @Test fun `a Seal goes stale when the rounds move under it`() {
        val draft = requireNotNull(seekerBidDraft(outbid, 1, nowOpen, null))
        val bid = SeekerSealIntent.Bid(outbid, draft)
        assertTrue(seekerSealCurrent(bid, SeekerAuctionState(current = outbid), nowOpen))
        val raised = view(listOf(row(0), row(1, "20000000", other, "8000000"), row(2), row(3)))
        assertFalse(seekerSealCurrent(bid, SeekerAuctionState(current = raised), nowOpen))
        assertFalse("the window closed", seekerSealCurrent(bid, SeekerAuctionState(current = outbid), 345_600L))
        val withdraw = SeekerSealIntent.Withdraw(outbid, 1)
        assertTrue(seekerSealCurrent(withdraw, SeekerAuctionState(current = outbid), nowOpen))
        val returned = view(listOf(row(0), row(1, "9000000", other), row(2), row(3)))
        assertFalse(seekerSealCurrent(withdraw, SeekerAuctionState(current = returned), nowOpen))
        assertNull(seekerSealUi(null, 0L))
        assertEquals("WITHDRAW FROM SPOT 2", seekerSealUi(withdraw, 0L)?.title)
    }

    // WHY: "SPOT n IS YOURS" is a money claim; it shows once per settlement, only from a finalized chain round, and not for
    // a term already over.
    @Test fun `each settled win celebrates once and never from fixture data or an ended term`() {
        val won = view(listOf(row(0, "9000000", WALLET, "9000000", settled = true), row(1), row(2), row(3)), now = afterWindow)
        val party = seekerNextCelebration(SeekerAuctionState(current = won), emptySet(), afterWindow)
        assertEquals("SPOT 1 IS YOURS", party?.ribbon)
        assertNull(seekerNextCelebration(SeekerAuctionState(current = won), setOf(party!!.receiptId), afterWindow))
        assertNull(seekerNextCelebration(SeekerAuctionState(current = won.copy(source = "fixture")), emptySet(), afterWindow))
        assertNull(seekerNextCelebration(SeekerAuctionState(current = won), emptySet(), 604_800L))
        assertNull("an unsettled lead is not yet a win", seekerNextCelebration(SeekerAuctionState(current = outbid), emptySet(), nowOpen))
    }

    // WHY: the re-read cadence is the auction service's own catalogue number; with none the panel reads only on open, never a
    // Kotlin copy of it.
    @Test fun `the refresh cadence comes only from the catalogue auction poll`() {
        fun catalogue(value: JsonElement?): JsonObject = buildJsonObject {
            putJsonObject("constants") { putJsonObject("PHASE_E_SEEKER_AUCTION_RUNTIME") { if (value != null) put("crankPollMs", value) } }
        }
        assertEquals(15_000L, seekerAuctionRefreshMs(catalogue(JsonPrimitive(15_000))))
        assertNull(seekerAuctionRefreshMs(catalogue(JsonPrimitive("15000"))))
        assertNull(seekerAuctionRefreshMs(catalogue(JsonPrimitive(0))))
        assertNull(seekerAuctionRefreshMs(catalogue(null)))
        assertNull(seekerAuctionRefreshMs(null))
    }
}
