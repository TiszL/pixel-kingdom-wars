package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SpotState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure rules behind the map HUD, the island scenes and the island sheets (design/final/map/SPEC.md, account §6). */
class MapLogicTest {
    private fun spot(no: Int, x: Float, y: Float, king: Boolean = false, look: SpotLook = SpotLook.AVAILABLE, mine: MineState = MineState.NONE,
        licence: LicenceState? = null) = SpotGeom(no, king, look, mine, IslandPoint(x, y), licence)

    private fun skr(amount: String?, status: PriceStatus = PriceStatus.OK) = PriceUi(Currency.SKR, amount, status)

    // SPEC §1.3: one button cycles the three modes; a fourth tap must come back to EXPLORE or the player gets stuck.
    @Test fun `the mode button cycles through all three modes and back`() {
        assertEquals(MapMode.WARZONE, nextMode(MapMode.EXPLORE))
        assertEquals(MapMode.KINGDOMS, nextMode(MapMode.WARZONE))
        assertEquals(MapMode.EXPLORE, nextMode(MapMode.KINGDOMS))
    }

    // SPEC §10 row 2: with 11 tiles at 80 dp a realms-first rail would push the live islands off a 412 dp phone.
    @Test fun `the rail puts Seeker, Solana and Divine first, then the realms in the caller's order`() {
        val (ordered, divider) = orderRail(listOf("frostveil", "divine", "elderwood", "seeker", "solana")) { it }
        assertEquals(listOf("seeker", "solana", "divine", "frostveil", "elderwood"), ordered)
        assertEquals("the divider follows the last island", 2, divider)
        assertEquals(-1, orderRail(listOf("frostveil")) { it }.second)
    }

    // SPEC §1.5: at most three trip markers, so the globe is never buried under timers.
    @Test fun `trip markers are capped at three, on-screen ones only`() {
        val shown = capMarkers(listOf(1, 2, 3, 4, 5)) { it != 2 }
        assertEquals(listOf(1, 3, 4), shown)
    }

    // SPEC §3.2: Z0 always groups crowded spots into bubbles; Z2 shows every spot on its own.
    @Test fun `clustering merges close spots at Z0 and never at Z2`() {
        val spots = listOf(spot(2, 100f, 100f), spot(1, 110f, 100f, king = true), spot(3, 1000f, 1000f))
        val z0 = clusterSpots(IslandKind.SEEKER, spots, zoom = 0, density = 2f)
        assertEquals(2, z0.size)
        assertEquals("members are in number order", listOf(1, 2), z0.first().members)
        assertTrue("a cluster holding a King spot gets the crown", z0.first().king)
        assertEquals(IslandPoint(105f, 100f), z0.first().at)
        val z2 = clusterSpots(IslandKind.SEEKER, spots, zoom = 2, density = 2f)
        assertEquals(3, z2.size)
        assertTrue(z2.all { it.members.size == 1 })
    }

    // SPEC §3.2: at Z1 only spots closer than 48 dp merge (here 48 dp = 96 art px at density 2, 1 device px per art px).
    @Test fun `at Z1 spots merge only when closer than 48 dp on screen`() {
        val near = clusterSpots(IslandKind.SEEKER, listOf(spot(1, 0f, 0f), spot(2, 90f, 0f)), zoom = 1, density = 2f)
        val far = clusterSpots(IslandKind.SEEKER, listOf(spot(1, 0f, 0f), spot(2, 100f, 0f)), zoom = 1, density = 2f)
        assertEquals(1, near.size)
        assertEquals(2, far.size)
    }

    // SPEC §3.2 priority table: an outbid bid of yours must never hide inside a calm-looking bubble.
    @Test fun `cluster face priority is outbid, then yours, then all blocked, then open`() {
        val open = spot(1, 0f, 0f)
        assertEquals(ClusterFace.RED, clusterFace(IslandKind.SEEKER, listOf(open, spot(2, 0f, 0f, mine = MineState.LEADING), spot(3, 0f, 0f, mine = MineState.OUTBID))))
        assertEquals(ClusterFace.GREEN, clusterFace(IslandKind.SEEKER, listOf(open, spot(2, 0f, 0f, mine = MineState.OPERATING))))
        assertEquals(ClusterFace.STONE, clusterFace(IslandKind.SEEKER, listOf(spot(1, 0f, 0f, look = SpotLook.EXPIRED), spot(2, 0f, 0f, look = SpotLook.EXPIRED))))
        assertEquals(ClusterFace.CREAM, clusterFace(IslandKind.SEEKER, listOf(open, spot(2, 0f, 0f, look = SpotLook.EXPIRED))))
        // Solana: all held by others is "all occupied" (stone); a licence you hold is green.
        assertEquals(ClusterFace.STONE, clusterFace(IslandKind.SOLANA, listOf(spot(1, 0f, 0f, licence = LicenceState.OCCUPIED))))
        assertEquals(ClusterFace.GREEN, clusterFace(IslandKind.SOLANA, listOf(spot(1, 0f, 0f, licence = LicenceState.MINE))))
    }

    // SPEC §3.3: the hit area is at least 48 dp and several hits pick the nearest centre.
    @Test fun `a tap picks the nearest target within 24 dp, and nothing further away`() {
        val cam = IslandCamera(scale = 1f, tx = 0f, ty = 0f)
        val targets = listOf(IslandTarget(IslandTap.Spot(1), IslandPoint(100f, 100f)), IslandTarget(IslandTap.Spot(2), IslandPoint(130f, 100f)))
        assertEquals(IslandTap.Spot(2), pickIslandTarget(targets, cam, density = 2f, tapXPx = 120f, tapYPx = 100f))
        assertEquals(IslandTap.Spot(1), pickIslandTarget(targets, cam, density = 2f, tapXPx = 105f, tapYPx = 100f))
        assertNull(pickIslandTarget(targets, cam, density = 2f, tapXPx = 100f, tapYPx = 160f))
    }

    // Pointer rule: markers are paint, so the scene's tap must not hit a spot the filter hid (D-191: hidden, never dimmed).
    @Test fun `the island tap ignores spots hidden by the filter but keeps the selected one`() {
        val ui = IslandSceneUi(IslandKind.SEEKER, "SEEKER ISLAND", "", emptyList(), AuctionPhase.OPEN, zoom = 2,
            spots = listOf(SpotMarkerUi(1, false, SpotLook.AVAILABLE, at = IslandPoint(100f, 200f)),
                SpotMarkerUi(2, true, SpotLook.AVAILABLE, at = IslandPoint(400f, 200f))), filter = SpotFilter.KING)
        val cam = IslandCamera(scale = 2f, tx = 0f, ty = 0f)
        // A lone sprite's visual centre is half its height (64 px at Z2 = 32 art px) above its foot.
        assertEquals(IslandTap.Spot(2), islandTap(ui, cam, 2f, 800f, 336f))
        assertNull("spot 1 is not a King spot, so it is hidden and cannot be hit", islandTap(ui, cam, 2f, 200f, 336f))
        assertEquals(IslandTap.Spot(1), islandTap(ui.copy(selected = 1), cam, 2f, 200f, 336f))
    }

    // SPEC §3.2 legend: MINE is what you hold or lead; BIDS is every live bid of yours, including the outbid one.
    @Test fun `filters keep the selected spot and sort your own states correctly`() {
        val outbid = spot(1, 0f, 0f, mine = MineState.OUTBID)
        assertFalse(spotPasses(SpotFilter.MINE, outbid, selected = null))
        assertTrue(spotPasses(SpotFilter.BIDS, outbid, selected = null))
        assertTrue(spotPasses(SpotFilter.MINE, spot(2, 0f, 0f, mine = MineState.OPERATING), selected = null))
        assertTrue("the selected spot always draws", spotPasses(SpotFilter.KING, outbid, selected = 1))
        assertEquals(listOf(SpotFilter.ALL, SpotFilter.MINE, SpotFilter.PUBLIC), islandFilters(IslandKind.SOLANA))
    }

    // DESIGN-SYSTEM §9: an unknown count is "…", never 0.
    @Test fun `unknown counts, grades and tiers read as the ellipsis`() {
        assertEquals("…", filterCount(emptyMap(), SpotFilter.MINE))
        assertEquals("0", filterCount(mapOf(SpotFilter.MINE to "0"), SpotFilter.MINE))
        assertEquals("GRADE …", gradeTag(null))
        assertEquals("TIER …", tierTag(0))
        assertEquals("TIER 2+", tierTag(2))
    }

    // SPEC §3.3: tags only where they help (Z1: yours and King; Z2: all), and your states carry their word and colour.
    @Test fun `spot tags follow the zoom rule and your states`() {
        assertNull(spotTag(spot(1, 0f, 0f, king = true), zoom = 0))
        assertNull(spotTag(spot(1, 0f, 0f), zoom = 1))
        assertEquals(SpotTagLook("1", null, true), spotTag(spot(1, 0f, 0f, king = true), zoom = 1))
        assertEquals(SpotTagLook("12 LEAD", Verb.GREEN, false), spotTag(spot(12, 0f, 0f, mine = MineState.LEADING), zoom = 1))
        assertEquals(SpotTagLook("42 OUTBID", Verb.RED, false), spotTag(spot(42, 0f, 0f, mine = MineState.OUTBID), zoom = 2))
        assertEquals(SpotTagLook("YOURS", Verb.GOLD, false), spotTag(spot(7, 0f, 0f, mine = MineState.OPERATING), zoom = 1))
        assertEquals(SpotTagLook("3 OCCUPIED", Verb.STONE, false), spotTag(spot(3, 0f, 0f, licence = LicenceState.OCCUPIED), zoom = 2))
    }

    // SPEC §3.2 / arch §5.3: fixture data must never be presented as a live auction.
    @Test fun `test data never shows the word LIVE and always carries TEST DATA`() {
        val tags = spotHeadTags(kingClass = true, state = SpotState.LIVE, countdown = "14h 10m", term = null, testData = true, phase = AuctionPhase.OPEN)
        assertTrue(tags.none { "LIVE" in it.text })
        assertTrue(tags.any { it.text == "TEST DATA" })
        assertEquals(HeadTag("KING", Verb.GOLD), tags.first())
        val live = spotHeadTags(false, SpotState.LIVE, "14h 10m", null, false, AuctionPhase.OPEN)
        assertEquals(listOf(HeadTag("LIVE 14h 10m", Verb.RED)), live)
        assertEquals("unknown time is the ellipsis", HeadTag("LIVE …", Verb.RED), spotHeadTags(false, SpotState.LIVE, null, null, false, AuctionPhase.OPEN).single())
    }

    // SPEC §3.2 honesty rule: with auctions off, bid buttons are hidden, not disabled; loading never offers a bid.
    @Test fun `the spot sheet hides bidding when the server has auctions off and checks while loading`() {
        val off = spotLayout(SpotState.LIVE, AuctionPhase.SERVER_OFF, loading = false, hasPermit = false)
        assertFalse(off.stepper); assertEquals(SpotPrimary.NONE, off.primary); assertTrue(off.offLine)
        assertEquals(SpotPrimary.CHECKING, spotLayout(SpotState.LIVE, AuctionPhase.OPEN, loading = true, hasPermit = false).primary)
        assertEquals(SpotPrimary.CHECKING, spotLayout(SpotState.LIVE, null, loading = false, hasPermit = false).primary)
        val outbid = spotLayout(SpotState.OUTBID, AuctionPhase.OPEN, false, false)
        assertTrue(outbid.heldRow); assertTrue(outbid.stepper); assertFalse("the held row replaces the bid cards", outbid.bidCards)
        assertEquals(SpotPrimary.LOCKED_OPENS, spotLayout(SpotState.NOT_OPEN, AuctionPhase.OPENS_AT, false, false).primary)
        assertEquals(SpotPrimary.CLAIM, spotLayout(SpotState.KING, AuctionPhase.OPERATING, false, false).primary)
        assertEquals(SpotPrimary.PERMIT, spotLayout(SpotState.CLOSED, AuctionPhase.OPERATING, false, hasPermit = true).primary)
        assertEquals(SpotPrimary.NONE, spotLayout(SpotState.CLOSED, AuctionPhase.OPERATING, false, hasPermit = false).primary)
    }

    // CRITIC §2.2: a game surface names a kingdom, never a wallet string.
    @Test fun `the top bidder is a kingdom name or a Seeker player`() {
        assertEquals("Kinmar", bidderName(" Kinmar "))
        assertEquals("a Seeker player", bidderName(null))
        assertEquals("a Seeker player", bidderName(""))
    }

    // Design correction 7: an uncertain money result must keep the recovery path and never claim nothing was spent.
    @Test fun `only an authoritative refusal says nothing was spent`() {
        val uncertain = moneyNote(true, "bid", authoritative = false)!!
        assertFalse(uncertain.contains("Nothing was spent"))
        assertTrue(uncertain.contains("Checking"))
        assertTrue(moneyNote(true, "bid", authoritative = true)!!.contains("Nothing was spent"))
        assertNull(moneyNote(false, "bid", authoritative = true))
    }

    // Owner decision 2026-10-02: Solana is a draw; with no draw the primary is locked with the reason, never invented.
    @Test fun `the licence primary follows the draw state`() {
        assertEquals(LicenceAction(LicencePrimary.LOCKED, "Licence draw opens later"), licenceAction(LicenceState.NONE, null, null, false))
        assertEquals(LicenceAction(LicencePrimary.LOCKED, "Licence draw opens later"), licenceAction(null, null, null, false))
        assertEquals(LicenceAction(LicencePrimary.ENTER, null), licenceAction(LicenceState.OPEN, false, "2d 4h", false))
        assertEquals(LicenceAction(LicencePrimary.ENTERED, "Drawn in 2d 4h"), licenceAction(LicenceState.OPEN, true, "2d 4h", false))
        assertEquals(LicenceAction(LicencePrimary.LOCKED, "Next draw opens later"), licenceAction(LicenceState.OCCUPIED, null, null, false))
        assertEquals(LicencePrimary.CLAIM, licenceAction(LicenceState.MINE, null, null, hasClaim = true).primary)
        assertEquals(LicencePrimary.NONE, licenceAction(LicenceState.MINE, null, null, hasClaim = false).primary)
        assertNull("no draw lights no step", litLicenceStep(LicenceState.NONE))
        assertEquals(LicenceState.OPEN, litLicenceStep(LicenceState.OPEN))
    }

    // SPEC §3.2 / §4.1: no countdown is invented; a server-off auction shows the banner instead of a chip.
    @Test fun `the countdown chip never invents a time`() {
        assertNull(countdownCopy(IslandKind.SEEKER, AuctionPhase.SERVER_OFF, null, "1h"))
        assertEquals(CountdownCopy("timer", "Bids close in", "…"), countdownCopy(IslandKind.SEEKER, null, null, "1h"))
        assertEquals(CountdownCopy("timer", "Bids close in", "14h 10m"), countdownCopy(IslandKind.SEEKER, AuctionPhase.OPEN, null, "14h 10m"))
        assertEquals(CountdownCopy("ui:queue-status", "Licence draw opens later", null), countdownCopy(IslandKind.SOLANA, null, LicenceState.NONE, "2d"))
        assertEquals(CountdownCopy("timer", "Draw closes in", "2d 4h"), countdownCopy(IslandKind.SOLANA, null, LicenceState.OPEN, "2d 4h"))
    }

    // SPEC §3.1: outbid is the most urgent alert, and the panel shows at most two.
    @Test fun `alerts are ordered by urgency and capped at two`() {
        val alerts = listOf(AlertKind.READY_TO_CLAIM, AlertKind.WON_UNCLAIMED, AlertKind.OUTBID)
        assertEquals(listOf(AlertKind.OUTBID, AlertKind.WON_UNCLAIMED), topAlerts(alerts) { it })
        assertEquals("…", phaseHeadline(null))
        assertFalse(phaseHeadline(AuctionPhase.OPEN).contains("LIVE"))
    }

    // Account SPEC §6.2: off = no buttons; the deed is the gate before SKR; the UI never compares amounts itself.
    @Test fun `the Reach sheet picks its primary from status, deed and the data lane's short flag`() {
        val off = reachLayout(ReachStatus.OFF, true, false)
        assertEquals(ReachPrimary.NONE, off.primary); assertFalse(off.info); assertNotNull(off.line)
        assertEquals(ReachPrimary.GET_LAND, reachLayout(ReachStatus.AVAILABLE, false, short = true).primary)
        assertEquals(ReachPrimary.GET_SKR, reachLayout(ReachStatus.AVAILABLE, true, short = true).primary)
        assertEquals(ReachPrimary.UNLOCK, reachLayout(ReachStatus.AVAILABLE, null, short = false).primary)
        assertEquals(ReachPrimary.BUY_BASE, reachLayout(ReachStatus.UNLOCKED_BY_ME, true, false).primary)
        assertEquals(ReachPrimary.NONE, reachLayout(ReachStatus.UNLOCKED_BY_OTHER, true, false).primary)
        assertTrue(isShort(skr("20,000"), skr("1,240", PriceStatus.SHORT)))
        assertFalse("a big-looking number is not short unless the data lane says so", isShort(skr("99,999,999"), skr("1")))
    }

    // Money rule: seals carry the data lane's amount untouched; fixture bids say so.
    @Test fun `seals pass the amount through and label test data`() {
        val amount = skr("130")
        val seal = bidSealUi(7, amount, raise = false, armedAtMs = 5L, testData = true)
        assertEquals("BID ON SPOT 7", seal.title)
        assertEquals(amount, seal.price)
        assertEquals(5L, seal.armedAtMs)
        assertTrue(seal.lines.any { it.contains("Test data") })
        assertEquals("RAISE", bidSealUi(7, amount, raise = true, armedAtMs = 0L, testData = false).confirmLabel)
        assertTrue(withdrawSealUi(42, skr("120"), 0L).lines.first().contains("120 SKR"))
        assertEquals("SPOT 7 IS YOURS", spotWonCelebration("rcpt", 7, "7 days").ribbon)
        assertEquals("TILE 1,204 UNLOCKED", reachUnlockedCelebration("rcpt", "1,204").ribbon)
    }

    // K-night-A4 (2026-10-10, provisional wording): the economy program holds a bid until the auction ends and returns it to
    // an outbid player only through WithdrawBid. Consent copy that promised an automatic refund would let a losing bidder
    // wait for SKR that never comes, so the bid seal and the spot sheet footnote both say WITHDRAW, from one line.
    @Test fun `bid consent says an outbid player withdraws, never that SKR comes back on its own`() {
        assertEquals("Held until the auction ends. If you are outbid, tap WITHDRAW to take it back.", SEEKER_BID_HELD_LINE)
        val seal = bidSealUi(7, skr("130"), raise = false, armedAtMs = 0L, testData = false)
        assertEquals(SEEKER_BID_HELD_LINE, seal.lines.first())
        assertEquals("the WITHDRAW it names is the seal that returns a held bid", "WITHDRAW", withdrawSealUi(7, skr("130"), 0L).confirmLabel)
        val sheet = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/map/SeekerSpotSheet.kt").readText()
        assertTrue("the footnote shares the line", sheet.contains("ParchLine(SEEKER_BID_HELD_LINE"))
        for (source in listOf(sheet, java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/map/MapLogic.kt").readText()))
            assertFalse("no automatic-refund promise", Regex("""returned if you lose|Returned if someone outbids""", RegexOption.IGNORE_CASE).containsMatchIn(source))
    }

    // SPEC §3.2: zoom levels are whole device-pixel steps, so pixel art never resamples at a fractional scale.
    @Test fun `zoom levels and sprite scales are whole steps`() {
        assertEquals(0.5f, levelScale(0), 0f)
        assertEquals(1f, levelScale(1), 0f)
        assertEquals(2f, levelScale(5), 0f)
        assertEquals(1, spriteScale(1))
        assertEquals(2, spriteScale(2))
        assertNull(clusterSpacingDp(2))
    }
}
