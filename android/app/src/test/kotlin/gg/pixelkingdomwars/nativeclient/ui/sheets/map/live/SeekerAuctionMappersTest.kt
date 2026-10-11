package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionConfig
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionSourcedRoundView
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionSpot
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.model.CelebrationUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.SpotState
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.AlertKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.AuctionPhase
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.CrestUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SpotAlertUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.SpotLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.bidderName
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.spotHeadTags
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Seeker auction mappers (plan onchain-client-reach.md §5.4 S-D; SPEC §3.1, §3.4-§3.7). The owner shows bidding, outbid,
 * WITHDRAW and the won celebration live on devnet test SKR, so every amount here must be the exact one the program charges,
 * every BID must be one the program admits, and nothing may claim a win, a live auction or a number the server never said.
 */
class SeekerAuctionMappersTest {
    private val other = "11111111111111111111111111111113"
    private val configAddress = "11111111111111111111111111111114"

    /** Deliberately not the production numbers: 6 decimals (as the test mint), a 7 SKR opening bid, a 30 min window and a
     *  3 day term from Monday 5 Jan 1970 00:00 UTC (epoch 345600), so every amount and time below is read from the view. */
    private val config = SeekerAuctionConfig(programId = "11111111111111111111111111111115", address = configAddress,
        mint = "11111111111111111111111111111116", prizeOwner = other, prizeAta = other, decimals = 6, openingBidRaw = "7000000",
        firstOperatingStart = "345600", termSec = "259200", auctionSec = "1800", graceSec = "600")

    /** Round 0's window is [343800, 345600); 900 s in. */
    private val nowOpen = 344_700L
    private val afterWindow = 400_000L

    private fun row(spot: Int, high: String = "0", leader: String? = null, yours: String = "0", settled: Boolean = false,
        opened: Boolean = true) = SeekerAuctionSpot(spot = spot, spotClass = if (spot == 0) "king" else "regular",
        realmMask = if (spot == 0) 255 else 15 shl (spot - 1), opened = opened, highBidRaw = high, highBidder = leader,
        settled = settled, yourBidRaw = yours, refundable = yours != "0" && leader != WALLET)

    private fun view(round: Int = 0, now: Long = nowOpen, spots: List<SeekerAuctionSpot> = (0..3).map { row(it) },
        skr: String? = "50000000", source: String = "chain", paused: Boolean = false, biddingRound: Int = round): SeekerAuctionSourcedRoundView {
        val start = 345_600L + round * 259_200L
        val settled = spots.count { it.settled }
        return SeekerAuctionSourcedRoundView(version = 1, source = source, chainUnixTime = now.toString(), walletSkrRaw = skr,
            wallet = WALLET, observedSlot = "9", round = round.toString(), biddingRound = biddingRound.toString(),
            admissionPaused = paused, config = config, auctionStart = (start - 1_800).toString(), auctionEnd = start.toString(),
            operatingStart = start.toString(), operatingEnd = (start + 259_200).toString(), openedCount = spots.count { it.opened },
            completedCount = settled, winnerCount = spots.count { it.settled && it.highBidder != null },
            completedAt = if (settled == spots.size) (start + 700).toString() else null, spots = spots)
    }

    /** Round 0 after its window, read while round 1 bids: Spot 1 settled to you, Spot 2 settled to another kingdom with 12 SKR
     *  of yours still held, Spot 3 still led by you and not yet settled, Spot 4 settled unsold. */
    private fun endedRound0() = view(round = 0, biddingRound = 1, now = afterWindow, spots = listOf(
        row(0, "150000000", WALLET, settled = true), row(1, "90000000", other, "12000000", settled = true),
        row(2, "8000000", WALLET, "8000000"), row(3, settled = true)))

    private fun round1() = view(round = 1, now = afterWindow, spots = (0..3).map { row(it, opened = false) })

    // WHY: the program refuses a total at or under the top bid or under the opening bid, and the server has no minIncrement;
    // a stepper that started lower would hand the wallet a transaction that can only fail.
    @Test fun `the minimum is the opening bid until someone bids, then one raw unit over the top bid rounded up to a whole SKR`() {
        val v = view(spots = listOf(row(0), row(1, "120000000", other), row(2, "120500001", other), row(3)))
        val first = seekerSpotUi(v, 0, nowOpen)!!.stepper!!
        assertEquals("7", first.value); assertEquals("min 7", first.minLine)
        assertEquals("BID 7", first.label); assertEquals("holds 7 SKR", first.sub)
        assertFalse("minus is off at the minimum", first.canDecrease); assertTrue(first.canIncrease)
        assertEquals("121", seekerSpotUi(v, 1, nowOpen)!!.stepper!!.value)
        assertEquals("a fractional top bid still rounds up to a whole SKR", "121", seekerSpotUi(v, 2, nowOpen)!!.stepper!!.value)
        val draft = seekerBidDraft(v, 2, nowOpen, null)!!
        assertEquals("the prepare amount is exact raw units", "121000000", draft.newTotalRaw)
        assertEquals("121000000", draft.incrementRaw); assertFalse(draft.raise)
        // The bid route refuses an increment the wallet balance does not cover (auctionRoutes.ts bidIntent): this view's
        // wallet holds 50 SKR, so the 121 SKR first bid is short by exactly 71 SKR, never "covered" (null).
        assertEquals("short = increment - wallet balance", "71000000", draft.shortRaw)
        assertEquals("0", draft.round); assertEquals(2, draft.spot)
    }

    // WHY: one step is one whole token derived from the mint decimals; minus must never offer a total the program refuses, and
    // a draft left under a newer top bid must snap up rather than sign a losing amount.
    @Test fun `plus and minus move one whole SKR and never go under the minimum`() {
        val v = view(spots = listOf(row(0), row(1, "120000000", other), row(2), row(3)))
        assertEquals("starts at the minimum", "122000000", seekerStepBid(v, 1, null, 1))
        assertEquals("122000000", seekerStepBid(v, 1, "121000000", 1))
        assertEquals("121000000", seekerStepBid(v, 1, "121000000", -1))
        assertEquals("121000000", seekerStepBid(v, 1, "123000000", -5))
        assertEquals("a draft under a newer top bid snaps up", "121000000", seekerStepBid(v, 1, "90000000", 0))
        assertEquals("a malformed draft is the minimum", "121000000", seekerStepBid(v, 1, "1e9", 0))
        val raised = seekerSpotUi(v, 1, nowOpen, draftRaw = "123000000")!!.stepper!!
        assertEquals("123", raised.value); assertEquals("min 121", raised.minLine); assertEquals("BID 123", raised.label)
        assertTrue(raised.canDecrease)
        assertNull("no such spot", seekerStepBid(v, 9, null, 1))
    }

    // WHY: SKR amounts are raw u64 base units; a double would round 9007199254740001 and show a raise that charges a different
    // amount from the one the wallet signs.
    @Test fun `amounts stay exact beyond double precision and up to u64 max`() {
        assertEquals("18,446,744,073,709.551615", seekerSkrText("18446744073709551615", 6))
        assertEquals("1.5", seekerSkrText("1500000", 6)); assertEquals("0.000001", seekerSkrText("1", 6))
        assertEquals("1,200", seekerSkrText("1200", 0)); assertEquals("0", seekerSkrText("0", 6))
        listOf("01", "-1", "1.5", "", "18446744073709551615000").forEach { assertNull(it, seekerSkrText(it, 6)) }
        val big = view(spots = listOf(row(0), row(1, "9007199254740993", other, "9007199254740001"), row(2), row(3)),
            skr = "18446744073709551615")
        val raise = seekerSpotUi(big, 1, nowOpen)!!.stepper!!
        assertEquals("RAISE TO 9,007,199,255", raise.label)
        assertEquals("adds 0.259999 SKR", raise.sub)
        assertEquals("259999", seekerBidDraft(big, 1, nowOpen, null)!!.incrementRaw)
        val nearMax = view(spots = listOf(row(0), row(1, "18446744073708999999", other), row(2, "18446744073709551614", other), row(3)),
            skr = "18446744073709551615")
        val last = seekerSpotUi(nearMax, 1, nowOpen)!!.stepper!!
        assertEquals("18,446,744,073,709", last.value); assertFalse("plus stops at u64 max", last.canIncrease)
        assertEquals("a step past u64 max keeps the draft", "18446744073709000000", seekerStepBid(nearMax, 1, null, 1))
        assertNull("no whole-token total fits above this top bid", seekerSpotUi(nearMax, 2, nowOpen)!!.stepper)
    }

    // WHY: the program tops up the escrow already held (it charges new total minus your bid), so RAISE must say it adds the
    // difference and the Seal must ask only for what actually leaves the wallet.
    @Test fun `a raise adds only the difference over the escrow already held`() {
        val v = view(spots = listOf(row(0, "150000000", WALLET, "150000000"), row(1, "150000000", other, "120000000"), row(2), row(3)))
        val outbid = seekerSpotUi(v, 1, nowOpen)!!
        assertEquals(SpotState.OUTBID, outbid.spot.state); assertEquals(SpotLook.OCCUPIED, outbid.look)
        assertEquals("120", outbid.held!!.amount); assertEquals(MoneyStage.READY, outbid.withdraw)
        assertEquals("RAISE TO 151", outbid.stepper!!.label); assertEquals("adds 31 SKR", outbid.stepper!!.sub)
        val seal = seekerBidSeal(v, seekerBidDraft(v, 1, nowOpen, null)!!, 5L)
        assertEquals("RAISE ON SPOT 2", seal.title); assertEquals("RAISE", seal.confirmLabel)
        assertEquals("the Seal asks for what leaves the wallet", "31", seal.price.amount)
        val lead = seekerSpotUi(v, 0, nowOpen)!!
        assertEquals(SpotState.YOU_LEAD, lead.spot.state); assertNull(lead.held); assertNull(lead.withdraw)
        assertEquals("RAISE TO 151", lead.stepper!!.label); assertEquals("adds 1 SKR", lead.stepper!!.sub)
        val fresh = seekerBidSeal(v, seekerBidDraft(v, 2, nowOpen, "9000000")!!, 5L)
        assertEquals("BID ON SPOT 3", fresh.title); assertEquals("9", fresh.price.amount); assertEquals("BID", fresh.confirmLabel)
    }

    // WHY: the program moves the increment from the wallet's token account; a BID the wallet cannot cover must say how much is
    // missing (Need-more) instead of opening a wallet prompt that fails, and an absent token account holds nothing.
    @Test fun `BID turns SHORT when the wallet cannot cover the increment and a missing token account holds nothing`() {
        val short = seekerSpotUi(view(skr = "5000000"), 1, nowOpen)!!.stepper!!.short!!
        assertEquals(PriceStatus.SHORT, short.status); assertEquals("Need 2 more SKR", short.amount)
        assertEquals("2000000", seekerBidDraft(view(skr = "5000000"), 1, nowOpen, null)!!.shortRaw)
        assertEquals("Need 7 more SKR", seekerSpotUi(view(skr = null), 1, nowOpen)!!.stepper!!.short!!.amount)
        assertNull("exactly enough is not short", seekerSpotUi(view(skr = "7000000"), 1, nowOpen)!!.stepper!!.short)
        val topUp = view(skr = "31000000", spots = listOf(row(0), row(1, "150000000", other, "120000000"), row(2), row(3)))
        assertNull("a raise needs only the increment", seekerSpotUi(topUp, 1, nowOpen)!!.stepper!!.short)
    }

    // WHY: the bid route refuses outside the window, while paused, before every spot is open and on fixture data; offering BID
    // there would be a door that can only fail.
    @Test fun `no BID is offered where the program would refuse the bid`() {
        val before = seekerSpotUi(view(now = 340_000), 1, 340_000)!!
        assertEquals(SpotState.NOT_OPEN, before.spot.state); assertNull(before.stepper)
        assertEquals("OPENS SUN 23:30 UTC", before.opensLine)
        val paused = seekerSpotUi(view(paused = true), 1, nowOpen)!!
        assertEquals(SpotState.NOT_OPEN, paused.spot.state); assertNull(paused.stepper)
        assertNull("when bidding resumes is unknown", paused.opensLine)
        assertNull(seekerSpotUi(view(spots = listOf(row(0), row(1), row(2), row(3, opened = false))), 1, nowOpen)!!.stepper)
        val fixture = seekerSpotUi(view(source = "fixture"), 1, nowOpen)!!
        assertEquals(SpotState.LIVE, fixture.spot.state); assertNull(fixture.stepper); assertTrue(fixture.spot.testData)
        assertNull("the clock past the window stops offering BID", seekerBidDraft(view(), 1, 345_600, null))
        assertNotNull(seekerBidDraft(view(), 1, 345_599, null))
        assertTrue("the read-time rule of the network port agrees", view().bidWindowOpen(1))
        assertFalse(seekerBidOpen(view(), 9, nowOpen))
    }

    // WHY: the state card tells the player whether they can bid now; its phase and time come from the round's chain calendar
    // (auctionSec, never "24 h"), and ENTER ISLAND stays a working door in every phase.
    @Test fun `the panel phase, time and meter follow the round calendar`() {
        val opens = seekerAuctionPanelUi(null, view(now = 340_000), null, 340_000)
        assertEquals(AuctionPhase.OPENS_AT, opens.phase); assertEquals("1h 3m", opens.phaseTime); assertNull(opens.phaseProgress)
        assertEquals("0", opens.mySpots); assertEquals("0", opens.myBids)
        val open = seekerAuctionPanelUi(null, view(), null, nowOpen)
        assertEquals(AuctionPhase.OPEN, open.phase); assertEquals("15m", open.phaseTime); assertEquals(0.5f, open.phaseProgress!!, 0.0001f)
        assertEquals("ENTER ISLAND", open.panel.primary.caption); assertEquals(CommandState.ENABLED, commandDrawState(open.panel.primary))
        assertEquals("the counts come from the view when the catalogue is unread", "4 spots, 1 of them King.", open.catalogueLine)
        assertFalse(open.error); assertFalse(open.testData)
        val stale = seekerAuctionPanelUi(null, view(), null, 345_600)
        assertEquals("the window closed on the clock", AuctionPhase.OPERATING, stale.phase)
        assertEquals("until the next round's window", "2d 23h", stale.phaseTime)
        val paused = seekerAuctionPanelUi(null, view(paused = true), null, nowOpen)
        assertEquals(AuctionPhase.OPENS_AT, paused.phase); assertNull(paused.phaseTime)
        val operating = seekerAuctionPanelUi(null, round1(), endedRound0(), afterWindow)
        assertEquals(AuctionPhase.OPERATING, operating.phase); assertEquals("2d 8h", operating.phaseTime)
    }

    // WHY: once the window ends the bidding round moves on, so wins and held escrow live in the previous round; without that
    // read the counts are unknown, never a made-up 0, and only a settled win counts as a spot.
    @Test fun `after the window MY SPOTS and MY BIDS read the previous round and are unknown without it`() {
        val unread = seekerAuctionPanelUi(null, round1(), null, afterWindow)
        assertEquals(UNKNOWN, unread.mySpots); assertEquals(UNKNOWN, unread.myBids)
        val read = seekerAuctionPanelUi(null, round1(), endedRound0(), afterWindow)
        assertEquals("only the settled win is a spot", "1", read.mySpots)
        assertEquals("the lead awaiting settlement is still a bid", "1", read.myBids)
        assertEquals(listOf(SpotAlertUi(2, AlertKind.OUTBID, "Outbid on Spot 2", "12 SKR held for you")), read.alerts)
        val wrong = seekerAuctionPanelUi(null, round1(), endedRound0().copy(round = "5"), afterWindow)
        assertEquals("a read of another round is ignored", UNKNOWN, wrong.mySpots)
        assertEquals("a finished term is no longer yours", "0", seekerAuctionPanelUi(null, round1(), endedRound0(), 604_800).mySpots)
    }

    // WHY: an outbid row is the only outbid signal tonight (no Herald push); it must carry the same held amount the spot sheet
    // shows, and a withdrawn bid holds nothing to warn about.
    @Test fun `outbid rows carry the held escrow the spot sheet shows and a withdrawn bid raises none`() {
        val v = view(spots = listOf(row(0, "20000000", other, "10000000"), row(1, "9000000", other, "8000000"), row(2, "9000000", other), row(3)))
        val ui = seekerAuctionPanelUi(null, v, null, nowOpen)
        assertEquals(listOf("Outbid on Spot 1", "Outbid on Spot 2"), ui.alerts.map { it.title })
        assertEquals(listOf(1, 2), ui.alerts.map { it.spotNo }); assertTrue(ui.alerts.all { it.kind == AlertKind.OUTBID })
        assertEquals("10 SKR held for you", ui.alerts.first().sub)
        assertEquals("10", seekerSpotUi(v, 0, nowOpen)!!.held!!.amount)
        assertEquals("2", ui.myBids)
    }

    // WHY: fixture data must never pass for a live auction: the panel and sheet carry TEST DATA, the timer is never a LIVE tag,
    // and neither BID nor WITHDRAW is offered on it.
    @Test fun `fixture data carries TEST DATA, never reads LIVE and offers no money action`() {
        val fixture = view(source = "fixture", spots = listOf(row(0), row(1, "9000000", other, "8000000"), row(2), row(3)))
        assertTrue(seekerAuctionPanelUi(null, fixture, null, nowOpen).testData)
        assertFalse(seekerAuctionPanelUi(null, view(), null, nowOpen).testData)
        val sheet = seekerSpotUi(fixture, 0, nowOpen)!!
        assertTrue(sheet.spot.testData)
        val tags = spotHeadTags(sheet.spot.kingClass, sheet.spot.state, sheet.spot.countdown, sheet.term, sheet.spot.testData, sheet.phase)
        assertTrue(tags.any { it.text == "TEST DATA" }); assertTrue(tags.none { it.text.contains("LIVE") })
        val held = seekerSpotUi(fixture, 1, nowOpen)!!
        assertNull(held.withdraw); assertNull(held.stepper); assertNull(seekerWithdrawSeal(fixture, 1, 0L))
    }

    // WHY: the won Celebration is receipt-gated (SPEC 3.7): only a spot the program has SETTLED to this wallet, read from the
    // chain, celebrates, once per settlement; an unsettled lead and another kingdom's win do not.
    @Test fun `only a settled win read from the chain celebrates, once per settlement`() {
        val ended = endedRound0()
        assertEquals(listOf(CelebrationUi("seeker-won:$configAddress:0:0", "ui:seeker-navigation", "SPOT 1 IS YOURS", "3d from Mon 00:00 UTC")),
            seekerWonCelebrations(ended))
        assertEquals("a later read of the same settlement keeps its receipt id", seekerWonCelebrations(ended),
            seekerWonCelebrations(ended.copy(chainUnixTime = "500000", observedSlot = "99")))
        assertTrue("fixture data never celebrates", seekerWonCelebrations(ended.copy(source = "fixture")).isEmpty())
        assertTrue("a live lead is not a win", seekerWonCelebrations(view(spots = listOf(row(0, "9000000", WALLET, "9000000"),
            row(1), row(2), row(3)))).isEmpty())
        val king = seekerSpotUi(ended, 0, afterWindow)!!
        assertEquals(SpotState.KING, king.spot.state); assertEquals(SpotLook.ACTIVE, king.look); assertEquals("2d 8h", king.term)
        val waiting = seekerSpotUi(ended, 2, afterWindow)!!
        assertEquals("an unsettled lead is not yet a win", SpotState.YOU_LEAD, waiting.spot.state)
        assertEquals("won and waiting", SpotLook.OCCUPIED, waiting.look); assertNull(waiting.stepper)
        val lost = seekerSpotUi(ended, 1, afterWindow)!!
        assertEquals(SpotState.OUTBID, lost.spot.state); assertEquals("12", lost.held!!.amount)
        assertEquals("WITHDRAW stays reachable after the window", MoneyStage.READY, lost.withdraw); assertNull(lost.stepper)
        val unsold = seekerSpotUi(ended, 3, afterWindow)!!
        assertEquals(SpotState.CLOSED, unsold.spot.state); assertEquals(SpotLook.EXPIRED, unsold.look)
    }

    // WHY: after the window the bidding round has moved on; the sheet of a spot you won, lead or hold escrow on must show that
    // round, or the player would see a fresh unopened spot instead of their win or their WITHDRAW.
    @Test fun `the spot sheet shows the previous round where only it holds your stake`() {
        val current = round1(); val previous = endedRound0()
        assertSame(previous, seekerSpotView(current, previous, 0))
        assertSame(previous, seekerSpotView(current, previous, 1))
        assertSame(previous, seekerSpotView(current, previous, 2))
        assertSame("no stake there", current, seekerSpotView(current, previous, 3))
        assertSame("a read of another round is ignored", current, seekerSpotView(current, previous.copy(round = "7"), 0))
        assertNull(seekerSpotView(null, previous, 0))
        val next = seekerSpotUi(current, 3, afterWindow)!!
        assertEquals(SpotState.NOT_OPEN, next.spot.state); assertEquals("OPENS WED 23:30 UTC", next.opensLine)
    }

    // WHY: CRITIC 2.2, a game surface names a kingdom or the player, never a wallet string.
    @Test fun `the top bidder reads you or a Seeker player and no wallet string reaches the sheet or panel`() {
        val v = view(spots = listOf(row(0, "9000000", other), row(1, "9000000", WALLET, "9000000"), row(2), row(3)))
        assertEquals("a Seeker player", bidderName(seekerSpotUi(v, 0, nowOpen)!!.highBidder!!.name))
        assertEquals("you", bidderName(seekerSpotUi(v, 1, nowOpen)!!.highBidder!!.name))
        assertNull(seekerSpotUi(v, 2, nowOpen)!!.highBidder)
        val drawn = (0..3).map { seekerSpotUi(v, it, nowOpen)!!.toString() } + seekerAuctionPanelUi(null, v, null, nowOpen).toString()
        drawn.forEach { text -> assertFalse(text.contains(other)); assertFalse(text.contains(WALLET)) }
    }

    // WHY: every Seeker surface on this client numbers spots from 1 (index + 1), and the crests are the realms the spot sells
    // permits for, in the same wire mapping as permits.
    @Test fun `spots are numbered from one and show the crests of their realm mask`() {
        val v = view()
        val king = seekerSpotUi(v, 0, nowOpen, realmNames = mapOf(0L to "Frostveil", 1L to "Elderwood"))!!
        assertEquals(1, king.spot.spotNo); assertTrue(king.spot.kingClass)
        assertEquals(8, king.crestsUi.size); assertEquals(CrestUi("frostveil", "Frostveil"), king.crestsUi.first())
        assertEquals("an unnamed realm falls back to its id", CrestUi("sunscar", "sunscar"), king.crestsUi[2])
        assertEquals("Sells permits for all 8 realms", king.crestLine)
        val regular = seekerSpotUi(v, 2, nowOpen)!!
        assertEquals(listOf("elderwood", "sunscar", "crownlands", "seeker-reach"), regular.crestsUi.map { it.realmId })
        assertEquals("Sells permits for 4 realms", regular.crestLine); assertFalse(regular.spot.kingClass)
        assertEquals(0, seekerSpotIndex(1, v)); assertEquals(3, seekerSpotIndex(4, v))
        assertNull(seekerSpotIndex(0, v)); assertNull(seekerSpotIndex(5, v)); assertNull(seekerSpotUi(v, 9, nowOpen))
    }

    // WHY: a loser gets SKR back only by signing WITHDRAW; its Seal must name exactly the escrow held, and nothing is offered
    // where nothing is held.
    @Test fun `the withdraw Seal names the exact escrow held and exists only where escrow is held`() {
        val v = view(spots = listOf(row(0, "20000000", other, "12500000"), row(1), row(2), row(3)))
        val seal = seekerWithdrawSeal(v, 0, 9L)!!
        assertEquals("WITHDRAW FROM SPOT 1", seal.title); assertEquals("Return 12.5 SKR to your wallet.", seal.lines.first())
        assertEquals("12.5", seal.price.amount)
        assertNull(seekerWithdrawSeal(v, 1, 9L)); assertNull(seekerWithdrawSeal(v, 9, 9L))
    }

    // WHY: nothing may crash on stage; a view this client cannot read shows the error line with RETRY, loading shows the
    // unknown mark, a failed refresh keeps the round already shown, and ENTER ISLAND stays a working door throughout.
    @Test fun `loading reads unknown and an unreadable view shows the error line instead of crashing`() {
        val loading = seekerAuctionPanelUi(null, null, null, 0L)
        assertNull(loading.phase); assertFalse(loading.error); assertEquals(UNKNOWN, loading.mySpots); assertEquals(UNKNOWN, loading.myBids)
        assertEquals(CommandState.ENABLED, loading.panel.primary.state)
        assertTrue(seekerAuctionPanelUi(null, null, null, 0L, error = true).error)
        val kept = seekerAuctionPanelUi(null, view(), null, nowOpen, error = true)
        assertTrue("a failed refresh keeps the shown round", kept.error); assertEquals(AuctionPhase.OPEN, kept.phase)
        val broken = view().copy(auctionEnd = "soon")
        val ui = seekerAuctionPanelUi(null, broken, null, nowOpen)
        assertTrue(ui.error); assertNull(ui.phase); assertEquals(CommandState.ENABLED, ui.panel.primary.state)
        assertNull(seekerSpotUi(broken, 0, nowOpen)); assertNull(seekerBidDraft(broken, 0, nowOpen, null))
        assertFalse(seekerBidOpen(broken, 0, nowOpen))
    }

    // WHY: bidding opens and closes on chain time; the device wall clock may be wrong, so time moves only by the monotonic
    // time elapsed since the read.
    @Test fun `chain time is the read clock plus monotonic elapsed time`() {
        assertEquals(344_702L, seekerChainNowSec(view(), 2_999L))
        assertEquals(344_700L, seekerChainNowSec(view(), -5_000L))
        assertNull(seekerPreviousRound(view())); assertEquals("0", seekerPreviousRound(round1()))
    }
}
