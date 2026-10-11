package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

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

/** The pure rules behind the Gold Forge sheet, its tabs and its Seals (design/final/goldforge/SPEC.md). */
class GoldForgeLogicTest {
    private val claim = ClaimUi("1,240", 3, "42", "Seeker wallet", "8f2K", null, MoneyStage.READY, "6h 20m", canResumeSaved = false, actionsAllowed = true)
    private val gems = GemsUi("1 KEEP = 1 GEM", "500", "500", "2,480", "1,980", listOf("100", "500", "1,000", "MAX"), "500", "1", "2,480",
        null, null, MoneyStage.READY, pendingRecovery = false, toShardsAvailable = true, swapOffered = false, actionsAllowed = true)
    private val spend = GemSpendUi(GemSpendKind.FINISH, "FINISH NOW?", "craft:workshop_t2_construction", "WORKSHOP", "Lv 2 › 3", 0.5f,
        "2h 14m", PriceUi(Currency.GEMS, "120", PriceStatus.OK), "1,250", "1,130", null, quotedAtMs = 0L, stage = MoneyStage.READY)

    // SPEC §1 Entry: a destination's explicit tab wins (MS-E sends lower-case ids), ready coins open CLAIM, else SMELT.
    @Test fun `the default tab follows the entry order`() {
        val tabs = listOf("SMELT", "CLAIM", "GEMS")
        assertEquals("GEMS", goldForgeDefaultTab("gems", tabs, claimReady = true))
        assertEquals("CLAIM", goldForgeDefaultTab(null, tabs, claimReady = true))
        assertEquals("SMELT", goldForgeDefaultTab(null, tabs, claimReady = false))
        assertEquals("CLAIM", goldForgeDefaultTab("legacy", tabs, claimReady = true))
        assertEquals("GEMS", goldForgeDefaultTab(null, listOf("GEMS"), claimReady = false))
        assertNull(goldForgeDefaultTab("smelt", emptyList(), claimReady = true))
    }

    // SPEC §1 Tabs: CLAIM is never hidden for being locked; LEGACY exists only when the Ui state carries it; the badges
    // are the ready "!" and the waiting-purchase count.
    @Test fun `the tab row never hides CLAIM and shows LEGACY only on request`() {
        val plain = goldForgeTabs(claimReady = false, gemsWaiting = 0, legacy = false)
        assertEquals(listOf("SMELT", "CLAIM", "GEMS"), plain.map { it.id })
        assertTrue(plain.none { it.locked || it.badge != null })
        val busy = goldForgeTabs(claimReady = true, gemsWaiting = 1, legacy = true)
        assertEquals(listOf("SMELT", "CLAIM", "GEMS", "LEGACY"), busy.map { it.id })
        assertEquals("!", busy[1].badge?.text)
        assertEquals("1", busy[2].badge?.text)
    }

    // SPEC §1 Tabs and legacy.png: SMELT shows the Gold Ingot and LEGACY the storage crate (authored ui: art, which the
    // kit TabStrip draws at 32 dp); CLAIM and GEMS keep the 24 dp KEEP token and gem.
    @Test fun `the tab icons are the designed art`() {
        assertEquals(listOf("ui:inv-forge-ingot", "keep", "gem", "ui:gf-storage-crate"),
            goldForgeTabs(claimReady = false, gemsWaiting = 0, legacy = true).map { it.icon })
    }

    // legacy.png: the LEGACY tab's chip says "Furnace lit" only (no coin timer, still the gold square). The flag never
    // changes any other status, so a lost server still reads as reconnecting.
    @Test fun `a bare forging hero says Furnace lit only`() {
        val bare = heroStatusLine(HeroStatusUi(HeroStatusKind.FORGING, time = "6h 20m", bare = true))
        assertEquals("Furnace lit", bare.text); assertNull(bare.emphasis); assertEquals(Verb.GOLD, bare.dot)
        assertEquals("Furnace lit", bare.spoken)
        assertEquals("Furnace lit · next coins in", heroStatusLine(HeroStatusUi(HeroStatusKind.FORGING, time = "6h 20m")).text)
        assertEquals("Reconnecting to the forge…", heroStatusLine(HeroStatusUi(HeroStatusKind.RECONNECTING, bare = true)).text)
        assertEquals("1h 12m", heroStatusLine(HeroStatusUi(HeroStatusKind.UNDER_CONSTRUCTION, time = "1h 12m", bare = true)).emphasis)
    }

    // Collecting cannot start where no claim owner can act: the ready CLAIM stays on its face, off, with the reason, and a
    // tap explains (EXPLAIN_LOCK) instead of doing nothing. An admitted owner, a saved claim, any money stage past READY,
    // the lock and the error keep their own looks, so receipt evidence is never hidden behind this line.
    @Test fun `a closed ready CLAIM explains why instead of claiming`() {
        val reason = "Collecting coins to your wallet is not open yet."
        val closed = claim.copy(actionsAllowed = false, closedReason = reason)
        val look = claimPrimaryLook(closed)
        assertEquals(ForgeAction.EXPLAIN_LOCK, look.action); assertEquals(CommandState.DISABLED, look.state)
        assertEquals(Verb.OFF, look.verb); assertEquals("CLAIM", look.label)
        assertEquals("1,240 KEEP to your wallet", look.sub); assertEquals(reason, look.reason)
        assertNull(claimPrimaryLook(closed.copy(ready = "…")).sub)
        val collected = claimPrimaryLook(closed.copy(phase = ClaimPhase.COLLECTED, ready = "0"))
        assertEquals(ForgeAction.EXPLAIN_LOCK, collected.action); assertNull(collected.sub); assertEquals(reason, collected.reason)
        assertEquals(ForgeAction.CLAIM, claimPrimaryLook(closed.copy(actionsAllowed = true)).action)
        assertEquals(ForgeAction.NONE, claimPrimaryLook(closed.copy(canResumeSaved = true)).action)
        assertEquals(Verb.MOSS, claimPrimaryLook(closed.copy(stage = MoneyStage.SENT)).verb)
        assertEquals(CommandState.BUSY, claimPrimaryLook(closed.copy(stage = MoneyStage.SENDING)).state)
        val locked = claimPrimaryLook(closed.copy(phase = ClaimPhase.LOCKED, lock = ClaimLockUi("Wed 14 Oct", null)))
        assertEquals(CommandState.LOCKED, locked.state); assertEquals("opens Wed 14 Oct", locked.sub)
        assertEquals("waiting for the server", claimPrimaryLook(closed.copy(phase = ClaimPhase.ERROR)).sub)
        // Without a reason the existing owner gate still closes it quietly (the gate tests pin that path).
        assertEquals(ForgeAction.NONE, claimPrimaryLook(claim.copy(actionsAllowed = false)).action)
    }

    // DESIGN-SYSTEM §9: an unknown or zero amount must never count as coins to claim.
    @Test fun `only a known positive amount is claimable`() {
        listOf(null, "", "…", "0", "0.00", "-5", "1.2M").forEach { assertFalse(it.toString(), isPositiveAmount(it)) }
        listOf("1,240", "0.5", "12", "312.5").forEach { assertTrue(it, isPositiveAmount(it)) }
    }

    // SPEC §1 hero copy: an unknown time reads "…", never "0"; the square is gold only while forging.
    @Test fun `the hero chip says what the forge is doing`() {
        val forging = heroStatusLine(HeroStatusUi(HeroStatusKind.FORGING, time = null))
        assertEquals("…", forging.emphasis)
        assertEquals(Verb.GOLD, forging.dot)
        assertEquals("Forge at rest · upgrading", heroStatusLine(HeroStatusUi(HeroStatusKind.AT_REST, reason = "upgrading")).text)
        assertEquals(Verb.STONE, heroStatusLine(HeroStatusUi(HeroStatusKind.RECONNECTING)).dot)
        assertEquals("1h 12m", heroStatusLine(HeroStatusUi(HeroStatusKind.UNDER_CONSTRUCTION, time = "1h 12m")).emphasis)
    }

    // Design correction 7: only an authoritative refusal may say nothing moved; an uncertain (or unknown) failure keeps
    // the recovery surface reachable instead of offering a fresh claim.
    @Test fun `an uncertain claim is checked, never retried as if nothing happened`() {
        val refused = claimPrimaryLook(claim.copy(stage = MoneyStage.FAILED, failure = MoneyFailure.REFUSED))
        assertEquals(ForgeAction.RETRY, refused.action)
        assertEquals(Verb.RED, refused.verb)
        val uncertain = claimPrimaryLook(claim.copy(stage = MoneyStage.FAILED, failure = MoneyFailure.UNCERTAIN))
        assertEquals(ForgeAction.CONTINUE, uncertain.action)
        assertEquals(Verb.STONE, uncertain.verb)
        assertEquals(uncertain, claimPrimaryLook(claim.copy(stage = MoneyStage.FAILED, failure = null)))
        assertEquals("Wallet said no. Nothing was sent.", forgeOutcomeLine("claim", MoneyFailure.REFUSED))
        listOf("claim", "purchase", "finish").forEach {
            assertFalse(forgeOutcomeLine(it, MoneyFailure.UNCERTAIN).contains("Nothing was"))
        }
    }

    // SPEC §4 states: each CLAIM state keeps one honest primary.
    @Test fun `the CLAIM primary follows the states table`() {
        val ready = claimPrimaryLook(claim)
        assertEquals(ForgeAction.CLAIM, ready.action)
        assertEquals("1,240 KEEP to your wallet", ready.sub)
        assertEquals(CommandState.BUSY, claimPrimaryLook(claim.copy(phase = ClaimPhase.LOADING)).state)
        val error = claimPrimaryLook(claim.copy(phase = ClaimPhase.ERROR))
        assertEquals(CommandState.DISABLED, error.state)
        assertEquals("waiting for the server", error.sub)
        val locked = claimPrimaryLook(claim.copy(phase = ClaimPhase.LOCKED, lock = ClaimLockUi("Wed 14 Oct", "after the first island auction")))
        assertEquals(CommandState.LOCKED, locked.state)
        assertEquals("opens Wed 14 Oct", locked.sub)
        assertEquals(ForgeAction.EXPLAIN_LOCK, locked.action)
        assertEquals("CONTINUE CLAIM", claimPrimaryLook(claim.copy(canResumeSaved = true)).label)
        // The wallet is asking: the sheet stays honest and its tap reopens the recovery surface.
        val wallet = claimPrimaryLook(claim.copy(stage = MoneyStage.CHECK_WALLET))
        assertEquals(CommandState.ENABLED, wallet.state)
        assertEquals(ForgeAction.CONTINUE, wallet.action)
        assertEquals(CommandState.BUSY, claimPrimaryLook(claim.copy(stage = MoneyStage.SENDING)).state)
        assertEquals(Verb.MOSS, claimPrimaryLook(claim.copy(stage = MoneyStage.SENT)).verb)
        // Nothing (or an unknown amount) to collect is never a CLAIM of zero.
        assertEquals(ForgeAction.NONE, claimPrimaryLook(claim.copy(ready = "0")).action)
        assertEquals(ForgeAction.NONE, claimPrimaryLook(claim.copy(ready = "…")).action)
    }

    // SPEC §5: a short wallet disables BUY with its reason; a waiting purchase continues; Gems off has no primary.
    @Test fun `the GEMS primary never buys what the wallet cannot pay`() {
        assertEquals(ForgeAction.BUY, gemsPrimaryLook(gems)?.action)
        assertEquals("paid with 500 KEEP from your wallet", gemsPrimaryLook(gems)?.sub)
        val short = gemsPrimaryLook(gems.copy(walletShort = true))
        assertEquals(CommandState.DISABLED, short?.state)
        assertEquals("Your wallet has 2,480 KEEP", short?.reason)
        assertEquals(ForgeAction.CONTINUE, gemsPrimaryLook(gems.copy(pendingRecovery = true))?.action)
        assertNull(gemsPrimaryLook(gems.copy(phase = GemsPhase.OFF)))
        assertEquals(ForgeAction.RETRY, gemsPrimaryLook(gems.copy(phase = GemsPhase.ERROR))?.action)
        assertEquals(CommandState.BUSY, gemsPrimaryLook(gems.copy(amount = "…"))?.state)
    }

    // SPEC §6: CHECKING waits, UNAVAILABLE explains, SHORT sends to the forge (never auto-spends), a server zero is free.
    @Test fun `the speed-up primary follows the live price`() {
        assertEquals(ForgeAction.CONFIRM, gemSpendPrimaryLook(spend).action)
        assertTrue(gemSpendArms(spend))
        assertEquals(CommandState.BUSY, gemSpendPrimaryLook(spend.copy(price = PriceUi(Currency.GEMS, null, PriceStatus.CHECKING))).state)
        val unavailable = gemSpendPrimaryLook(spend.copy(price = PriceUi(Currency.GEMS, null, PriceStatus.UNAVAILABLE)))
        assertEquals(CommandState.DISABLED, unavailable.state)
        assertNotNull(unavailable.reason)
        val short = gemSpendPrimaryLook(spend.copy(short = "40"))
        assertEquals(ForgeAction.GET_GEMS, short.action)
        assertEquals(Verb.BLUE, short.verb)
        assertEquals(ForgeAction.GET_GEMS, gemSpendPrimaryLook(spend.copy(price = PriceUi(Currency.GEMS, "120", PriceStatus.SHORT))).action)
        val free = spend.copy(price = PriceUi(Currency.GEMS, "0", PriceStatus.SERVER_ZERO))
        assertFalse(gemSpendArms(free))
        assertEquals(ForgeAction.CONFIRM, gemSpendPrimaryLook(free).action)
        assertEquals(ForgeAction.RETRY, gemSpendPrimaryLook(spend.copy(stage = MoneyStage.FAILED, failure = MoneyFailure.REFUSED)).action)
        assertEquals(ForgeAction.NONE, gemSpendPrimaryLook(spend.copy(stage = MoneyStage.FAILED)).action)
        assertEquals("SKIP", gemSpendConfirmLabel(GemSpendKind.SKIP))
    }

    // SPEC §3: HELD finds a raid (red), QUALIFIED has nothing to press, a disabled or locked SMELT keeps its reason.
    @Test fun `the SMELT primary follows the furnace state`() {
        val held = smeltPrimaryLook(SmeltState.HELD, smeltPrimaryCommand(SmeltState.HELD, 0))
        assertEquals(ForgeAction.FIND_RAID, held?.action)
        assertEquals(Verb.RED, held?.verb)
        assertNull(smeltPrimaryLook(SmeltState.QUALIFIED, smeltPrimaryCommand(SmeltState.QUALIFIED, 0, payoutIn = "6h 20m")))
        assertEquals("PAYOUT IN 6h 20m", smeltPrimaryCommand(SmeltState.QUALIFIED, 0, payoutIn = "6h 20m").caption)
        assertEquals("PAYOUT IN …", smeltPrimaryCommand(SmeltState.QUALIFIED, 0).caption)
        val choosing = smeltPrimaryLook(SmeltState.CHOOSING, smeltPrimaryCommand(SmeltState.CHOOSING, 7))
        assertEquals(ForgeAction.SMELT, choosing?.action)
        assertEquals(Verb.GOLD, choosing?.verb)
        assertEquals("7 items", choosing?.sub)
        assertEquals("1 item", smeltPrimaryCommand(SmeltState.CHOOSING, 1).sub)
        val empty = smeltPrimaryLook(SmeltState.CHOOSING, smeltPrimaryCommand(SmeltState.CHOOSING, 0))
        assertEquals(CommandState.DISABLED, empty?.state)
        assertEquals(ForgeAction.NONE, empty?.action)
        val paused = smeltPrimaryLook(SmeltState.PAUSED, smeltPrimaryCommand(SmeltState.PAUSED, 3))
        assertEquals("New smelting is paused", paused?.reason)
        assertEquals(CommandState.LOCKED, smeltPrimaryLook(SmeltState.NOT_READY, smeltPrimaryCommand(SmeltState.NOT_READY, 0))?.state)
        assertEquals(ForgeAction.RETRY, smeltPrimaryLook(SmeltState.ERROR, smeltPrimaryCommand(SmeltState.ERROR, 0))?.action)
        assertEquals(CommandState.BUSY, smeltPrimaryLook(SmeltState.LOADING, smeltPrimaryCommand(SmeltState.CHOOSING, 3))?.state)
    }

    // SPEC §3a: the pool id becomes game words; the basket is green only while choosing; no cap reads "Uncapped today".
    @Test fun `the furnace header and load label use game words`() {
        assertEquals("Free furnace", furnaceLabel("free"))
        assertEquals("Deed furnace", furnaceLabel("DEED"))
        assertEquals("…", furnaceLabel(""))
        assertEquals(LoadText("+1,800", " of 5,000"), furnaceLoadText(SmeltState.CHOOSING, "0", "1,800", "5,000"))
        assertEquals(LoadText(null, "1,800 of 5,000"), furnaceLoadText(SmeltState.HELD, "1,800", "1,800", "5,000"))
        assertEquals(LoadText(null, "0 of 5,000"), furnaceLoadText(SmeltState.CHOOSING, "0", "0", "5,000"))
        assertEquals(LoadText(null, "Uncapped today"), furnaceLoadText(SmeltState.HELD, "10", null, null))
        assertEquals(LoadText("+50", " · Uncapped today"), furnaceLoadText(SmeltState.CHOOSING, "0", "50", null))
    }

    // SPEC §3c.4 and §3b: at most three held tiles (the last slot becomes "+n"), and two basket icons on the seal.
    @Test fun `the held strip and seal icons stay within their slots`() {
        fun tile(id: String, chosen: Int = 1) = SmeltTileUi(id, "icon-$id", "x1", chosen, "1", "Workshop")
        assertEquals(3 to 0, heldStrip(List(3) { tile("$it") }).let { it.first.size to it.second })
        assertEquals(2 to 3, heldStrip(List(5) { tile("$it") }).let { it.first.size to it.second })
        assertEquals(listOf("icon-b", "icon-c"), smeltSealIcons(listOf(tile("a", 0), tile("b"), tile("c"), tile("d"))))
        assertEquals(7, basketCount(listOf(tile("a", 2), tile("b", 5), tile("c", 0))))
        assertEquals(36, tileIconDp("shards"))
        assertEquals(32, tileIconDp("craft:inv_crownsteel"))
    }

    // SPEC §3b / §6a: nothing arms before consent, and a re-quote restarts the arming.
    @Test fun `seals arm only after consent and restart on a new quote`() {
        assertNull(consentArmStart(1_000L, null))
        assertEquals(5_000L, consentArmStart(1_000L, 5_000L))
        assertEquals(1_000L, consentArmStart(1_000L, 500L))
        assertEquals(9_000L, quoteArmStart(1_000L, 9_000L))
        assertEquals(1_000L, quoteArmStart(1_000L, Long.MIN_VALUE))
    }

    // SPEC §4c: the seal names the wallet app, never an address.
    @Test fun `the wallet tag is the app name only`() {
        assertEquals("SEEKER", walletTag("Seeker wallet"))
        assertEquals("PHANTOM", walletTag("Phantom"))
        assertEquals("WALLET", walletTag(null))
        assertEquals("WALLET", walletTag("  "))
    }
}
