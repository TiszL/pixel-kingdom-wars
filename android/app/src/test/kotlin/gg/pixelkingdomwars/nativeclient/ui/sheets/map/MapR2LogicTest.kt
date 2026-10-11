package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure rules of map round 2 (design/final/map/SPEC.md "Round 2 additions" §A-§E + critic fixes). Each test names the
 * promise it keeps: a consent never arms on a guessed price, an uncertain money result is never shown as settled, a door
 * is reachable by a thumb, and an unknown number never draws as zero.
 */
class MapR2LogicTest {
    private fun sol(amount: String?, status: PriceStatus) = PriceUi(Currency.SOL, amount, status)

    // §A + design correction 7: a CHECKING quote may open the Seal (navigation) but must never let BUY send money.
    @Test fun `the permit seal arms only on a known price and only in a state that can send`() {
        assertTrue(permitSealCanArm(sol("0.01", PriceStatus.OK), MoneyStage.READY))
        assertTrue(permitSealCanArm(sol("0", PriceStatus.SERVER_ZERO), MoneyStage.READY))
        assertTrue("RETRY after an authoritative failure", permitSealCanArm(sol("0.01", PriceStatus.OK), MoneyStage.FAILED))
        assertFalse(permitSealCanArm(sol(null, PriceStatus.CHECKING), MoneyStage.READY))
        assertFalse(permitSealCanArm(sol(null, PriceStatus.UNAVAILABLE), MoneyStage.READY))
        assertFalse(permitSealCanArm(sol("0.01", PriceStatus.SHORT), MoneyStage.READY))
        assertFalse("nothing can be sent twice", permitSealCanArm(sol("0.01", PriceStatus.OK), MoneyStage.SENDING))
        assertFalse(permitSealCanArm(sol("0.01", PriceStatus.OK), MoneyStage.CHECK_WALLET))
        assertEquals("Checking the price…", permitSealWaitLine(sol(null, PriceStatus.CHECKING)))
        assertNull(permitSealWaitLine(sol("0.01", PriceStatus.OK)))
    }

    // §A: a covered realm can still be bought (the term adds on top); dimmed tiles explain themselves instead of selecting.
    @Test fun `permit tiles select sold realms and explain home and not-sold ones`() {
        assertEquals(PermitTileTap.SELECT, permitTileTap(PermitRealmState.OPEN))
        assertEquals(PermitTileTap.SELECT, permitTileTap(PermitRealmState.COVERED))
        assertEquals(PermitTileTap.NOT_SOLD, permitTileTap(PermitRealmState.NOT_SOLD))
        assertEquals(PermitTileTap.HOME, permitTileTap(PermitRealmState.HOME))
        assertTrue(permitTileDimmed(PermitRealmState.HOME))
        assertFalse(permitTileDimmed(PermitRealmState.COVERED))
    }

    // §A states: "TO 9 OCT" while covered, moss OPEN only after the receipt, and an unknown date never invents one.
    @Test fun `permit tile tags follow the receipt and never invent a date`() {
        assertEquals(MapTagUi("TO 9 OCT", Verb.STONE), permitTileTag(PermitRealmState.COVERED, "9 OCT", justBought = false))
        assertEquals(MapTagUi("TO …", Verb.STONE), permitTileTag(PermitRealmState.COVERED, null, justBought = false))
        assertEquals(MapTagUi("OPEN", Verb.MOSS), permitTileTag(PermitRealmState.COVERED, "10 OCT", justBought = true))
        assertNull(permitTileTag(PermitRealmState.OPEN, null, justBought = false))
    }

    @Test fun `the quota line says sold out, or the ellipsis when unknown`() {
        assertEquals("Sold out here today", permitQuotaLine("0 of 10 left here today", soldOut = true))
        assertEquals("…", permitQuotaLine(null, soldOut = false))
        assertEquals("6 of 10 left here today", permitQuotaLine("6 of 10 left here today", soldOut = false))
    }

    // Critic fix: the permit Seal names the spot and keeps every SOL cost line in the fine print, with one consistent price.
    @Test fun `the permit seal content names the seller spot and keeps costs in the fine print`() {
        val c = permitSealContent(PermitSealUi("Frostveil", sol("0.01", PriceStatus.OK), "Sat 10 Oct", "0.0121 SOL", MoneyStage.READY), "Kaly", 7)
        assertEquals("BUY FROSTVEIL PERMIT", c.title)
        assertEquals("Bought from Kaly's spot 7.", c.secondary)
        assertTrue(c.finePrint.first().contains("at most 0.0121 SOL"))
        assertTrue(c.lines.none { it.contains("SOL") })
        assertTrue(c.canArm)
        val unknownSeller = permitSealContent(PermitSealUi("Frostveil", sol(null, PriceStatus.CHECKING), "Sat 10 Oct", "", MoneyStage.READY), "", 9)
        assertEquals("Bought from a Seeker player's spot 9.", unknownSeller.secondary)
        assertFalse(unknownSeller.canArm)
        assertTrue(unknownSeller.finePrint.first().contains("at most …"))
    }

    // Critic fix: the tabs are MATERIALS · SHARDS · REALM'S CUT; an unknown id lands on the drawn default.
    @Test fun `rewards tabs round-trip and unknown ids fall back to materials`() {
        RewardsTab.entries.forEach { assertEquals(it, rewardsTabOf(rewardsTabId(it))) }
        assertEquals(RewardsTab.MATERIALS, rewardsTabOf("KEEP_TAX"))
        assertEquals(RewardsTab.MATERIALS, rewardsTabOf(null))
        assertEquals("Shards and the realm's cut are claimed on their own tabs.", rewardsFootnote(RewardsTab.MATERIALS))
    }

    // §B uncertain: a saved claim reads "being checked", never as sent and never as claimable again.
    @Test fun `an earlier term being checked is neither ready nor sent`() {
        assertEquals("BEING CHECKED", termTag(TermState.CHECKING)?.text)
        assertEquals(Verb.GREEN, termTag(TermState.READY)?.verb)
        assertEquals(Verb.MOSS, termTag(TermState.CLAIMED)?.verb)
        assertNull(termTag(TermState.NONE))
    }

    // §B: the SOL lines live only in the Seal's fine print and never show a made-up number.
    @Test fun `the realm's cut fine print drops unknown maxima instead of inventing them`() {
        assertEquals("A one-time wallet setup may be needed (at most 0.002 SOL) and a network cost (at most 0.0001 SOL).",
            realmsCutFinePrint("0.002", "0.0001"))
        assertFalse(realmsCutFinePrint(null, null).contains("at most"))
        assertTrue(realmsCutFinePrint(null, "0.0001").startsWith("A network cost applies (at most 0.0001 SOL)"))
        val setup = realmsCutSealContent(TaxSealUi(PriceUi(Currency.KEEP, "12.5", PriceStatus.OK), true, "0.002", "0.0001", MoneyStage.READY, 0L))
        assertEquals("SET UP ONCE", setup.title)
        assertTrue(setup.lines.none { it.contains("SOL") })
    }

    // §C: both doors stay tappable at Z0 with a ≥ 96 dp hit area; empty sea selects nothing.
    @Test fun `a tap within 48 dp of a door picks it, the nearer door wins, the sea picks nothing`() {
        val camera = IslandCamera(0.5f, 0f, 0f) // Z0: 1 device px per 2 art px
        val density = 2f
        val westX = camera.screenX(DIVINE_WEST_ANCHOR.x); val westY = camera.screenY(DIVINE_WEST_ANCHOR.y)
        assertEquals(DivineDoor.WEST, pickDivineDoor(camera, density, westX + 90f, westY))      // 45 dp away
        assertNull(pickDivineDoor(camera, density, westX + 100f, westY))                      // 50 dp away
        val eastX = camera.screenX(DIVINE_EAST_ANCHOR.x); val eastY = camera.screenY(DIVINE_EAST_ANCHOR.y)
        assertEquals(DivineDoor.EAST, pickDivineDoor(camera, density, eastX, eastY + 10f))
        val near = IslandPoint(100f, 100f); val far = IslandPoint(200f, 100f)
        assertEquals(DivineDoor.EAST, pickDivineDoor(IslandCamera(1f, 0f, 0f), 2f, 160f, 100f, west = near, east = far))
    }

    // §C default: WEST is preselected on entry only while trials are open; the player's own pick always wins.
    @Test fun `the default door is west on entry while trials are open`() {
        assertEquals(DivineDoor.WEST, divineSelectedDoor(null, entered = true, trialsOpen = true))
        assertNull(divineSelectedDoor(null, entered = true, trialsOpen = false))
        assertEquals(DivineDoor.EAST, divineSelectedDoor(DivineDoor.EAST, entered = true, trialsOpen = true))
        assertEquals(0.5f, divineLevelScale(0))
        assertEquals(1f, divineLevelScale(1))
    }

    // §D: "2 of 3" draws two gold pips and one dark; an unknown count draws none (never three dark).
    @Test fun `tries pips show the tries left and never invent a zero`() {
        assertEquals(listOf(true, true, false), triesFills(2, 3))
        assertEquals(listOf(false, false, false), triesFills(0, 3))
        assertEquals(listOf(true, true, true), triesFills(5, 3))
        assertNull(triesFills(null, 3))
        assertNull(triesFills(2, null))
        assertEquals(listOf(true, true, false), trialStars(2))
        assertEquals(listOf(false, false, false), trialStars(null))
    }

    // §D STANDINGS: the gold rule sits before the first rank outside the top 500; unknown ranks never move it.
    @Test fun `the top-500 rule goes before the first rank past the cutoff`() {
        assertEquals(2, topCutoffIndex(listOf(499, 500, 501, 502)))
        assertEquals(-1, topCutoffIndex(listOf(1, 2, 3)))
        assertEquals(0, topCutoffIndex(listOf(612, 613)))
        assertEquals(2, topCutoffIndex(listOf(null, 12, 900)))
    }

    // §D / §E uncertain: an attempt or delivery still being checked must block a second send.
    @Test fun `a saved request being checked keeps the trials and deliver primaries off`() {
        assertEquals(CommandState.DISABLED, trialPrimaryState(CommandState.ENABLED, attemptChecking = true))
        assertEquals(CommandState.ENABLED, trialPrimaryState(CommandState.ENABLED, attemptChecking = false))
        assertEquals(CommandState.LOCKED, trialPrimaryState(CommandState.LOCKED, attemptChecking = true))
        assertEquals(CommandState.DISABLED, deliverState(CommandState.ENABLED, recoveryPending = true))
        assertEquals(CommandState.BUSY, deliverState(CommandState.BUSY, recoveryPending = true))
    }

    // §C: the FRAGMENTS badge is a gold count of what waits, hidden at zero or unknown.
    @Test fun `the fragments badge is a gold count only when something waits`() {
        assertEquals("12", fragmentsBadge(12)?.text)
        assertEquals(BadgeTone.REWARD, fragmentsBadge(12)?.tone)
        assertEquals("99+", fragmentsBadge(140)?.text)
        assertNull(fragmentsBadge(0))
        assertNull(fragmentsBadge(null))
        assertEquals(MapTagUi("READY", Verb.GREEN), sourceTag(SourceState.READY))
        assertNull(sourceTag(SourceState.LOCKED))
    }
}
