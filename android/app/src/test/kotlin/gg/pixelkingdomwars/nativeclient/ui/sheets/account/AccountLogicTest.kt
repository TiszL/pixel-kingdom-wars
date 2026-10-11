package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure rules behind the account cluster (design/final/account/SPEC.md). Each test names the player-facing promise it
 * keeps: honest numbers ("…", never a fake 0 or "free"), money moved is money honoured (a lost answer is "being checked",
 * never "nothing was spent"; design correction 7), one land per wallet, nobody locks themselves out of their account,
 * and the roster powers the clan rules give.
 */
class AccountLogicTest {
    private fun sol(amount: String?, status: PriceStatus) = PriceUi(Currency.SOL, amount, status)
    private fun member(id: String, role: ClanRole = ClanRole.MEMBER, trophies: Long? = 100, wins: Int? = 1, online: Boolean = false, you: Boolean = false) =
        ClanMemberUi(id, id, role, you, false, "10", 3, "seen", online, trophies, trophies?.toString() ?: "…", wins, "league-gold")

    // A refusal must be explained, a shortage must lead to where the money is earned, and a busy button must never send twice.
    @Test fun `primary taps route short to need-more, locked to an explanation and busy to nothing`() {
        assertEquals(PrimaryTap.ACT, primaryTap(PrimaryLook("GO", null, Verb.GOLD, CommandState.ENABLED, null)))
        assertEquals(PrimaryTap.NEED_MORE, primaryTap(PrimaryLook("BUY", null, Verb.GOLD, CommandState.SHORT, "Not enough")))
        assertEquals(PrimaryTap.EXPLAIN, primaryTap(PrimaryLook("GO", null, Verb.GOLD, CommandState.LOCKED, "Opens Thu")))
        assertEquals(PrimaryTap.IGNORE, primaryTap(PrimaryLook("GO", null, Verb.GOLD, CommandState.BUSY, null)))
    }

    // Wallet rows must never be blank or show a full 44-char address the row cannot fit.
    @Test fun `addresses shorten to head and tail and unknown is an ellipsis`() {
        assertEquals("7xKp…4f2k", shortAddress("7xKpQ9Zr2mLwV8sT1aBcDeFgHiJk4f2k"))
        assertEquals("abc", shortAddress("abc"))
        assertEquals("…", shortAddress(null))
        assertEquals("…", shortAddress("  "))
    }

    // SPEC §1.1: connecting a wallet is the money sequence minus SENT (nothing was paid), and a returning player is greeted.
    @Test fun `the title connect never shows SENT and greets a returning wallet`() {
        assertEquals(MoneyStage.READY, titleConnectStage(null))
        assertEquals(MoneyStage.READY, titleConnectStage(TitleBusy.SOCIAL))
        assertEquals(MoneyStage.CHECK_WALLET, titleConnectStage(TitleBusy.WALLET_CHECK))
        assertEquals(MoneyStage.SENDING, titleConnectStage(TitleBusy.WALLET_SENDING))
        assertEquals("CONNECT WALLET", titleConnectLabel(null))
        assertEquals("CONTINUE AS 7xKp…4f2k", titleConnectLabel("7xKp…4f2k"))
        assertEquals("123", totpDraft("12a3"))
        assertEquals("123456", totpDraft("1234567"))
    }

    // One land per wallet and a server switch-off must lock the gate with a reason; a price problem must not block browsing realms.
    @Test fun `the land gate locks only for server off or an owned land and asks for a wallet first`() {
        assertEquals(CommandState.LOCKED, landGatePrimary(walletLinked = true, alreadyOwned = false, serverOffReason = "Paused").state)
        assertEquals("Paused", landGatePrimary(true, false, "Paused").reason)
        val owned = landGatePrimary(walletLinked = true, alreadyOwned = true, serverOffReason = null)
        assertEquals(CommandState.LOCKED, owned.state)
        assertTrue(owned.reason!!.contains("One land per wallet"))
        val noWallet = landGatePrimary(walletLinked = false, alreadyOwned = false, serverOffReason = null)
        assertEquals("CONNECT WALLET", noWallet.label)
        assertEquals(CommandState.ENABLED, noWallet.state)
        assertEquals("CHOOSE REALM", landGatePrimary(true, false, null).label)
    }

    // Design correction 7: an unknown price is navigation into the Seal (which shows "…"), never a dead button and never "0".
    @Test fun `settle stays enabled while the price is checking and shows an ellipsis, not zero`() {
        val checking = settleLook("Crownlands", RealmLock.NONE, sol(null, PriceStatus.CHECKING))
        assertEquals(CommandState.ENABLED, checking.state)
        assertEquals("SETTLE IN CROWNLANDS", checking.label)
        assertEquals("… SOL · one land per wallet", checking.sub)
        assertEquals(CommandState.DISABLED, settleLook("Crownlands", RealmLock.NONE, sol(null, PriceStatus.UNAVAILABLE)).state)
        assertEquals(CommandState.SHORT, settleLook("Crownlands", RealmLock.NONE, sol("0.2", PriceStatus.SHORT)).state)
        assertEquals(CommandState.DISABLED, settleLook(null, null, sol("0.2", PriceStatus.OK)).state)
        assertEquals(CommandState.DISABLED, settleLook("Frostveil", RealmLock.FULL, sol("0.2", PriceStatus.OK)).state)
        assertEquals(CommandState.LOCKED, settleLook("Solana Reach", RealmLock.SKR_UNLOCK, sol("0.2", PriceStatus.OK)).state)
    }

    // Money moved is money honoured: a lost answer may have paid, so it must never claim nothing was spent.
    @Test fun `a lost land payment answer is being checked and only a refusal says nothing was spent`() {
        assertNull(landPaymentLine(PaymentOutcome.IN_FLIGHT))
        val checking = landPaymentLine(PaymentOutcome.CHECKING)!!
        assertTrue(checking.contains("checking"))
        assertFalse(checking.contains("Nothing was spent"))
        assertTrue(landPaymentLine(PaymentOutcome.REFUSED)!!.contains("Nothing was spent"))
        assertEquals("The wallet declined. Nothing was spent.", landPaymentLine(PaymentOutcome.REFUSED, "The wallet declined"))
    }

    // CRITIC §2.2: the network fee lives in the Seal's fine print, and the player sees what they get (the deed).
    @Test fun `the land seal pays SOL for the deed and keeps the fee in its fine print`() {
        val seal = landSealUi("Crownlands", sol("0.2", PriceStatus.OK), armedAtMs = 7L)
        assertEquals("BUY LAND IN CROWNLANDS?", seal.title)
        assertEquals("BUY LAND", seal.confirmLabel)
        assertEquals(7L, seal.armedAtMs)
        assertEquals("itm_deed_earth", seal.gets?.icon)
        assertTrue(seal.lines.last().contains("network fee"))
        assertFalse(seal.lines.dropLast(1).any { it.contains("fee") })
    }

    // SPEC §1.2: the land herald nags for three sessions at most, and never once the player owns land.
    @Test fun `the land herald shows on the first three landless sessions only`() {
        assertTrue(landHeraldShown(landless = true, sessionNumber = 1))
        assertTrue(landHeraldShown(landless = true, sessionNumber = 3))
        assertFalse(landHeraldShown(landless = true, sessionNumber = 4))
        assertFalse(landHeraldShown(landless = false, sessionNumber = 1))
        assertFalse(landHeraldShown(landless = true, sessionNumber = 0))
    }

    // The tutorial plate must never cover the building the step asks the player to tap.
    @Test fun `the tutorial plate sits under the target when it fits, else above, never off screen`() {
        assertEquals(520f, coachPlateTop(targetTop = 400f, targetBottom = 500f, plateHeight = 60f, areaHeight = 900f, gap = 20f))
        assertEquals(320f, coachPlateTop(targetTop = 400f, targetBottom = 850f, plateHeight = 60f, areaHeight = 900f, gap = 20f))
        assertEquals(0f, coachPlateTop(targetTop = 30f, targetBottom = 880f, plateHeight = 60f, areaHeight = 900f, gap = 20f))
    }

    @Test fun `the kingdoms tab knows landless, one and many`() {
        assertEquals(KingdomsMode.LANDLESS, kingdomsMode(landless = true, kingdomCount = 0))
        assertEquals(KingdomsMode.LANDLESS, kingdomsMode(landless = false, kingdomCount = 0))
        assertEquals(KingdomsMode.ONE, kingdomsMode(false, 1))
        assertEquals(KingdomsMode.MANY, kingdomsMode(false, 2))
    }

    // Honest numbers: "free" is a server statement, never a default.
    @Test fun `a second land is called free only on a server zero`() {
        assertEquals("Your second land is free", addKingdomSub(sol("0", PriceStatus.SERVER_ZERO)))
        assertEquals("Another land: 0.2 SOL", addKingdomSub(sol("0.2", PriceStatus.OK)))
        assertEquals("Another land: … SOL", addKingdomSub(sol(null, PriceStatus.CHECKING)))
        assertFalse(addKingdomSub(sol(null, PriceStatus.CHECKING)).contains("free"))
        assertFalse(addKingdomSub(sol("0", PriceStatus.OK)).contains("free"))
    }

    @Test fun `the history line never invents counts`() {
        assertEquals("2 need you · 41 done", historyLine(2, 41))
        assertEquals("41 done", historyLine(0, 41))
        assertEquals("… need you · … done", historyLine(null, null))
    }

    // SPEC §4.3: the last sign-in method can never be unlinked (the player would be locked out of their kingdom).
    @Test fun `the last sign-in method cannot be unlinked`() {
        val both = mapOf(ProviderKind.WALLET to true, ProviderKind.GOOGLE to true, ProviderKind.X to false)
        assertTrue(canUnlink(both, ProviderKind.GOOGLE))
        assertFalse(canUnlink(both, ProviderKind.X))
        val walletOnly = mapOf(ProviderKind.WALLET to true, ProviderKind.GOOGLE to false)
        assertFalse(canUnlink(walletOnly, ProviderKind.WALLET))
        assertEquals("G", providerLetter(ProviderKind.GOOGLE))
    }

    @Test fun `save name only for a real change and never twice`() {
        assertTrue(nameSaveEnabled("Mira", "Rowan", saving = false))
        assertFalse(nameSaveEnabled(" Rowan ", "Rowan", saving = false))
        assertFalse(nameSaveEnabled("  ", "Rowan", saving = false))
        assertFalse(nameSaveEnabled("Mira", "Rowan", saving = true))
    }

    // LANE-SKR-FAUCET: deed required, mainnet hidden, a lost claim answer is checked, never "nothing was spent".
    @Test fun `the faucet card follows the deed rule and honest outcomes`() {
        assertNull(faucetLook(FaucetUi.Hidden))
        assertNull(faucetRowLine(FaucetUi.Hidden))
        val locked = faucetLook(FaucetUi.NeedsDeed)!!
        assertEquals(FaucetButton.GET_LAND, locked.button)
        assertTrue(locked.locked)
        assertTrue(locked.line.contains("Kingdom Deed"))
        val ready = faucetLook(FaucetUi.Ready("1,000"))!!
        assertEquals(FaucetButton.CLAIM, ready.button)
        assertEquals("CLAIM 1,000", ready.claimLabel)
        assertTrue(ready.rim)
        assertTrue(ready.line.contains("no real value"))
        assertEquals(MoneyStage.SENDING, faucetLook(FaucetUi.Claiming("1,000", MoneyStage.SENDING))!!.stage)
        val checking = faucetLook(FaucetUi.Checking)!!
        assertEquals(FaucetButton.RECHECK, checking.button)
        assertFalse(checking.line.contains("Nothing was spent"))
        val claimed = faucetLook(FaucetUi.ClaimedToday("7h 12m"))!!
        assertEquals(FaucetButton.NONE, claimed.button)
        assertEquals("7h 12m", claimed.nextIn)
        assertEquals(FaucetButton.NONE, faucetLook(FaucetUi.Unavailable("Paused"))!!.button)
        assertEquals("+1,000 ready today", faucetRowLine(FaucetUi.Ready("1,000")))
        // Extended 2026-10-06: the locked headline's daily amount is the catalogue's grant (SKR_FAUCET.devnet.grantSkr), so a
        // changed grant can never be advertised as the old literal "1,000"; unknown reads "…".
        assertEquals("2,500 SKR a day", faucetLook(FaucetUi.NeedsDeed, dailyAmount = "2,500")!!.headline)
        assertEquals("… SKR a day", locked.headline)
        assertFalse(locked.headline.contains("1,000"))
        // Public wording never sells "free" (the frame's "Free once a day" line was reworded): no state's copy says it.
        listOf(FaucetUi.NeedsDeed, FaucetUi.Ready("1,000"), FaucetUi.Claiming("1,000", MoneyStage.FAILED), FaucetUi.ClaimedToday("7h 12m"),
            FaucetUi.Unavailable("Paused"), FaucetUi.Checking).forEach { state ->
            val look = faucetLook(state, "1,000")!!
            assertFalse("$state", look.line.contains("free", ignoreCase = true))
            assertFalse("$state", look.headline.contains("free", ignoreCase = true))
        }
        assertEquals("Once a day for deed holders. Test SKR, no real value.", ready.line)
    }

    @Test fun `the shop primary buys the selected offer and sends a shortage to need-more`() {
        val gems = PriceUi(Currency.GEMS, "150", PriceStatus.OK)
        assertEquals(CommandState.DISABLED, supplyBuyLook(null, null, null, null).state)
        val ok = supplyBuyLook("BUY 2-DAY SHIELD", "150 Gems · shield becomes 52h", gems, null)
        assertEquals(CommandState.ENABLED, ok.state)
        assertEquals("150 Gems · shield becomes 52h", ok.sub)
        assertEquals(CommandState.SHORT, supplyBuyLook("BUY", null, gems.copy(status = PriceStatus.SHORT), null).state)
        assertEquals(CommandState.LOCKED, supplyBuyLook("BUY", null, gems, "Next one in 2d").state)
        assertEquals(CommandState.DISABLED, supplyBuyLook("BUY", null, gems.copy(status = PriceStatus.UNAVAILABLE), null).state)
    }

    // The scrolling tab strip must always show the whole active tab and a peek of the next (SPEC §0.3: no hidden tabs).
    @Test fun `the tab strip scrolls the active tab into view with the next one peeking`() {
        val widths = listOf(100f, 100f, 100f, 100f, 100f, 100f) // 600 + 5 × 4 = 620 total
        assertEquals(0f, stackedTabScrollTarget(widths, 4f, active = 0, viewportPx = 380f, peekPx = 28f))
        // Tab 4 ends at 516; the next must peek 28 after a 4 gap: 548 − 380 = 168.
        assertEquals(168f, stackedTabScrollTarget(widths, 4f, active = 4, viewportPx = 380f, peekPx = 28f))
        // The last tab clamps to the end of the strip.
        assertEquals(240f, stackedTabScrollTarget(widths, 4f, active = 5, viewportPx = 380f, peekPx = 28f))
        // Going back to tab 1 from the end brings its start into view.
        assertEquals(104f, stackedTabScrollTarget(widths, 4f, active = 1, viewportPx = 380f, peekPx = 28f, currentPx = 240f))
        assertEquals(0f, stackedTabScrollTarget(emptyList(), 4f, 0, 380f, 28f))
        assertEquals(72, scrollingTabWidthDp("HQ"))
        assertEquals(106, scrollingTabWidthDp("SUPPLIES"))
    }

    // The roster must sort the way the chip says, with unknown values last (never treated as zero).
    @Test fun `members sort by trophies, wins or online first, unknown last`() {
        val members = listOf(member("a", trophies = 500, wins = 9), member("b", trophies = null, wins = 2), member("c", trophies = 900, wins = null, online = true),
            member("d", trophies = 100, wins = 4, online = true))
        assertEquals(listOf("c", "a", "d", "b"), sortMembers(members, MemberSort.TROPHIES).map { it.id })
        assertEquals(listOf("a", "d", "b", "c"), sortMembers(members, MemberSort.WINS).map { it.id })
        assertEquals(listOf("c", "d", "a", "b"), sortMembers(members, MemberSort.ONLINE).map { it.id })
    }

    // SPEC §5.1: leaders and elders promote, only the leader removes, and nobody acts on themselves or on the leader.
    @Test fun `member powers follow the clan roles`() {
        assertEquals(MemberPowers(canPromote = false, canKick = false), memberPowers(ClanRole.MEMBER, member("x")))
        assertEquals(MemberPowers(canPromote = true, canKick = false), memberPowers(ClanRole.ELDER, member("x")))
        assertEquals(MemberPowers(canPromote = false, canKick = false), memberPowers(ClanRole.ELDER, member("e", ClanRole.ELDER)))
        assertEquals(MemberPowers(canPromote = true, canKick = true), memberPowers(ClanRole.LEADER, member("e", ClanRole.ELDER)))
        assertEquals(MemberPowers(canPromote = false, canKick = false), memberPowers(ClanRole.LEADER, member("l", ClanRole.LEADER)))
        assertEquals(MemberPowers(canPromote = false, canKick = false), memberPowers(ClanRole.LEADER, member("me", you = true)))
    }

    @Test fun `clan name and tag rules and the min trophies stepper`() {
        assertNull(clanNameError(""))
        assertNull(clanNameError("Iron Wardens"))
        assertEquals("3 to 16 letters", clanNameError("Ir"))
        assertEquals("3 to 16 letters", clanNameError("A".repeat(17)))
        assertEquals("Letters, numbers and spaces only", clanNameError("Iron_Wardens"))
        assertNull(clanTagError("IRN"))
        assertEquals("3 or 4 letters", clanTagError("IRONW"))
        assertEquals("IRN4", clanTagDraft("i-r n4x"))
        assertEquals(700, stepMinTrophies(600, 1, 100, 0, 5000))
        assertEquals(0, stepMinTrophies(50, -1, 100, 0, 5000))
        assertEquals(5000, stepMinTrophies(4950, 1, 100, 0, 5000))
    }

    // CREATE CLAN: no Clan Hall locks with its reason; an unknown price is still navigation into the review Seal.
    @Test fun `create clan locks without a hall and stays enabled while the price is unknown`() {
        assertEquals(CommandState.LOCKED, clanCreateLook("Build a Clan Hall (Keep 4)", "Iron Wardens", "IRN", null).state)
        assertEquals(CommandState.DISABLED, clanCreateLook(null, "Ir", "IRN", null).state)
        assertEquals(CommandState.ENABLED, clanCreateLook(null, "Iron Wardens", "IRN", null).state)
        assertEquals(CommandState.ENABLED, clanCreateLook(null, "Iron Wardens", "IRN", sol(null, PriceStatus.CHECKING)).state)
        assertEquals(CommandState.SHORT, clanCreateLook(null, "Iron Wardens", "IRN", sol("0.05", PriceStatus.SHORT)).state)
    }

    @Test fun `the tournament track lights done, current and to-come steps`() {
        assertEquals(listOf(StepTone.DONE, StepTone.CURRENT, StepTone.TODO), tourneySteps(TourneyPhase.ENTRY, entered = true))
        assertEquals(listOf(StepTone.CURRENT, StepTone.TODO, StepTone.TODO), tourneySteps(TourneyPhase.ENTRY, entered = false))
        assertEquals(listOf(StepTone.DONE, StepTone.DONE, StepTone.CURRENT), tourneySteps(TourneyPhase.RESULTS, entered = true))
    }

    // FIND MATCH is the red attack only when it can really start a fight; otherwise it keeps its place and says why.
    @Test fun `find match is red only while battles are open for a rostered player with fights left`() {
        val open = tourneyLook(TourneyPhase.BATTLES, entered = true, amCaptain = false, inRoster = true, fightsUsed = 1, fightsMax = 3, opensIn = null, prizeClaimable = false)
        assertEquals(Verb.RED, open.verb)
        assertEquals(CommandState.ENABLED, open.state)
        val waiting = tourneyLook(TourneyPhase.ENTRY, true, false, true, 0, 3, "Battles open Thu 18:00 UTC · 1d 4h", false)
        assertEquals(CommandState.LOCKED, waiting.state)
        assertEquals("Battles open Thu 18:00 UTC · 1d 4h", waiting.reason)
        assertEquals("You joined after the roster locked", tourneyLook(TourneyPhase.BATTLES, true, false, false, 0, 3, null, false).reason)
        assertEquals(CommandState.DISABLED, tourneyLook(TourneyPhase.BATTLES, true, false, true, 3, 3, null, false).state)
        val captain = tourneyLook(TourneyPhase.ENTRY, entered = false, amCaptain = true, inRoster = false, fightsUsed = null, fightsMax = null, opensIn = null, prizeClaimable = false)
        assertEquals("ENTER CLAN", captain.label)
        assertEquals(Verb.GOLD, captain.verb)
        assertEquals("Your captain enters the clan", tourneyLook(TourneyPhase.ENTRY, false, false, false, null, null, null, false).reason)
        assertEquals("CLAIM PRIZE", tourneyLook(TourneyPhase.RESULTS, true, false, true, 3, 3, null, prizeClaimable = true).label)
    }

    @Test fun `charter tools are the captain's, and a pause locks them for everyone`() {
        assertNull(charterToolsLock(amCaptain = true, pausedReason = null))
        assertEquals("captain", charterToolsLock(amCaptain = false, pausedReason = null))
        assertEquals("Charter changes are paused", charterToolsLock(amCaptain = true, pausedReason = "Charter changes are paused"))
        assertNotNull(charterToolsLock(false, "Paused"))
    }
}
