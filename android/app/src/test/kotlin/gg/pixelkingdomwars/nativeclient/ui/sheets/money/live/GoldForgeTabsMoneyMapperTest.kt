package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.miningcontribution.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.*
import org.junit.Assert.*
import org.junit.Test

/** Authored before implementation; source-only until Cedar3's admitted composed run. */
class GoldForgeTabsMoneyMapperTest {
    private val wallet = "11111111111111111111111111111112"
    private val other = "11111111111111111111111111111113"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val identity = StarterIdentity("https://example.invalid", "devnet", wallet)
    private val miningIdentity = MiningContributionIdentity(identity.origin, identity.cluster, wallet)
    private val policy = MiningClaimsProtocolPolicy(3, 1, 71)
    private fun contribution() = MiningContributionState(
        MiningContributionJournal(1, miningIdentity, 0, null, emptyList()),
        MiningContributionView(wallet, base, 3, "2026-10-04", "2026-10-04T07:00:00.000Z", true,
            "free", "100000", "9007199254740993", "0", true,
            miningContributionResourceIds(3).map { MiningContributionStock(it, "17", "23") },
            MiningConsistencyPolicy(7, 17, 119)), advertised = true)
    private fun claims() = MiningClaimsState(loaded = true,
        journal = MiningClaimsJournal(1, identity, 0, null, emptyList()),
        status = MiningClaimStatusView(MiningClaimFeatures(MiningClaimFeature(1, 1)), wallet,
            "shardkeep-economy", other, wallet, "ready", null, "1", "9007199254740993", "0",
            "9007199254740993", 3, 5, "200", "100", false, false, true, false,
            "2026-10-04T07:00:00.000Z"))
    private fun cap() = GemsCapability(true, listOf("wallet-keep"), other, 1, 17, 3, 91)
    private fun buy() = GemsBuyState(available = true, capability = cap())
    private fun smelt(s: MiningContributionState = contribution()) = goldForgeSmeltTabUi(
        s, miningIdentity, base, repositoryCurrent = true, viewCurrent = true)
    private fun claim(s: MiningClaimsState = claims()) = goldForgeClaimTabUi(s, identity, policy,
        repositoryCurrent = true, statusCurrent = true, ownerHandoffReady = true)
    private fun gems(s: GemsBuyState = buy(), funds: String? = "23.5", current: Boolean = true, requestedKeep: Long = 7, capabilityCurrent: Boolean = true) =
        goldForgeGemsTabUi(s, identity, repositoryCurrent = true, capabilityCurrent = capabilityCurrent,
            ownerHandoffReady = true, requestedKeep = requestedKeep, walletFunds = WalletFunds(null, mapOf("KEEP" to funds), 0),
            walletCurrent = current)

    @Test fun `smelt retained state is not freshness`() {
        assertNull(goldForgeSmeltTabUi(contribution(), miningIdentity, base))
    }
    @Test fun `smelt rejects another wallet or base`() {
        assertNull(smelt(contribution().copy(view = contribution().view!!.copy(wallet = other))))
        assertNull(goldForgeSmeltTabUi(contribution(), miningIdentity, "other", true, true))
    }
    @Test fun `smelt retains exact large committed value and server cap`() {
        val ui = requireNotNull(smelt()); assertEquals("9007199254740993", ui.committed)
        assertEquals("100000", ui.cap); assertEquals(1f, ui.committedFill)
    }
    @Test fun `smelt display cannot create a basket spend or result`() {
        val ui = requireNotNull(smelt()); assertEquals(CommandState.DISABLED, ui.primary.state)
        assertTrue(ui.tiles.all { !it.canAdd && it.chosen == 0 }); assertNull(ui.seal); assertNull(ui.result)
    }
    @Test fun `smelt failure or busy read is absent`() {
        assertNull(smelt(contribution().copy(busy = true)))
        assertNull(smelt(contribution().copy(advertised = false)))
    }
    @Test fun `smelt current deed reports uncapped only from server`() {
        val ui = smelt(contribution().copy(view = contribution().view!!.copy(pool = "deed", dailyCapValue = null, remainingValue = null)))!!
        assertNull(ui.cap)
    }
    @Test fun `claim body requires accepted existing owner handoff`() {
        assertNull(goldForgeClaimTabUi(claims(), identity, policy, true, true))
    }
    @Test fun `claim scales u64 without floating point or compact truncation`() {
        val ui = requireNotNull(claim()); assertEquals("9007199254740.993", ui.ready)
        assertEquals(ClaimPhase.READY, ui.phase); assertEquals(MoneyStage.READY, ui.stage)
        assertNull(ui.seal); assertFalse(ui.canResumeSaved)
    }
    @Test fun `claim currentness and identity are independently required`() {
        assertNull(goldForgeClaimTabUi(claims(), identity, policy, true, false, true))
        assertNull(claim(claims().copy(status = claims().status!!.copy(wallet = other))))
        assertNull(claim(claims().copy(journal = claims().journal!!.copy(identity = identity.copy(wallet = other)))))
    }
    @Test fun `claim invalid catalogue decimals refuse rather than rescale`() {
        assertNull(goldForgeClaimTabUi(claims(), identity, policy.copy(tokenDecimals = 2), true, true, true))
    }
    @Test fun `claim delayed date uses supplied chain gate not a calendar default`() {
        val ui = claim(claims().copy(status = claims().status!!.copy(state = "delayed", preparationAllowed = false,
            chainUnixTimestamp = "50", claimableAfterUnixTimestamp = "100")))!!
        assertEquals(ClaimPhase.LOCKED, ui.phase); assertEquals("1970-01-01T00:01:40Z", ui.lock!!.date)
    }
    @Test fun `claim paused and revoked are not fabricated locked or empty states`() {
        assertNull(claim(claims().copy(status = claims().status!!.copy(state = "paused", preparationAllowed = false))))
    }
    @Test fun `saved claim recovery remains discoverable without current status`() {
        val request = MiningClaimPrepareRequest("00000000-0000-4000-8000-000000000002")
        val s = claims().copy(status = null, error = "refresh unavailable", journal = claims().journal!!.copy(
            operation = MiningClaimsOperation(request, policy)))
        val ui = goldForgeClaimTabUi(s, identity, policy, true, false, true)!!
        assertTrue(ui.canResumeSaved); assertEquals("…", ui.ready); assertNull(ui.seal)
    }
    @Test fun `Gems body requires explicit current owner handoff`() {
        assertNotNull(gems()) // Positive control: every input except the gate is admitted.
        assertNull(goldForgeGemsTabUi(buy(), identity, true, true, ownerHandoffReady = false,
            requestedKeep = 7, walletFunds = WalletFunds(null, mapOf("KEEP" to "23.5"), 0), walletCurrent = true))
        // Omitting the handoff flag must be just as closed as explicitly passing false.
        assertNull(goldForgeGemsTabUi(buy(), identity, true, true,
            requestedKeep = 7, walletFunds = WalletFunds(null, mapOf("KEEP" to "23.5"), 0), walletCurrent = true))
        val saved = SavedGemsBuy(GemsBuyDraft(wallet, identity.origin, identity.cluster, "saved-key-123", 7))
        assertNull(goldForgeGemsTabUi(GemsBuyState(saved = saved), identity, true, false, false))
    }
    @Test fun `Gems quote is server bounded and wallet exact`() {
        val ui = gems()!!; assertEquals("7", ui.amount); assertEquals("7", ui.pay)
        assertEquals("16.5", ui.walletAfter); assertEquals("3", ui.min); assertEquals("91", ui.max)
        assertTrue(ui.quick.isEmpty()); assertNull(ui.seal); assertFalse(ui.toShardsAvailable); assertFalse(ui.swapOffered)
    }
    @Test fun `Gems rejects a request outside server bounds`() {
        assertNotNull(gems()); assertNull(gems(requestedKeep = 92)); assertNull(gems(requestedKeep = 2))
    }
    @Test fun `unknown or stale wallet is not sufficient funds`() {
        assertNull(gems(funds = null)); assertNull(gems(current = false))
        assertNull(gems(funds = "1e9")); assertNull(gems(funds = "-2"))
    }
    @Test fun `short wallet never becomes actionable buy`() {
        val ui = gems(funds = "6.9")!!; assertTrue(ui.walletShort)
        val look = gemsPrimaryLook(ui.copy(actionsAllowed = true))!!
        assertEquals(CommandState.DISABLED, look.state); assertEquals(ForgeAction.NONE, look.action)
        assertEquals("Your wallet has 6.9 KEEP", look.reason)
    }
    @Test fun `saved Gems original remains a handoff even when capability is lost`() {
        val saved = SavedGemsBuy(GemsBuyDraft(wallet, identity.origin, identity.cluster, "saved-key-123", 7))
        val ui = goldForgeGemsTabUi(GemsBuyState(saved = saved), identity, true, false, true)!!
        assertTrue(ui.pendingRecovery); assertEquals("7", ui.pay); assertEquals("…", ui.amount)
        assertFalse(ui.swapOffered); assertFalse(ui.toShardsAvailable); assertTrue(ui.quick.isEmpty())
        assertNull(ui.seal); assertEquals(MoneyStage.READY, ui.stage)
        // The kit gate opens only after the existing owner has bound recovery and Seal.
        assertEquals(ForgeAction.NONE, gemsPrimaryLook(ui)!!.action)
        assertEquals(ForgeAction.CONTINUE, gemsPrimaryLook(ui.copy(actionsAllowed = true))!!.action)
    }
    @Test fun `saved Gems from another identity never crosses accounts`() {
        val saved = SavedGemsBuy(GemsBuyDraft(other, identity.origin, identity.cluster, "saved-key-123", 7))
        assertNull(goldForgeGemsTabUi(GemsBuyState(saved = saved), identity, true, false, true))
    }
    @Test fun `Gems retained capability is unavailable after a failed repository probe`() {
        val current = buy()
        // No saved quote or receipt: these flags are false in the real repository's new-purchase state.
        assertNull(current.saved); assertFalse(current.fresh); assertFalse(current.hydrated)
        assertNotNull(gems(current))
        assertNull(gems(current.copy(available = false)))
    }
    @Test fun `Gems new purchase requires the independent current capability witness`() {
        assertNotNull(gems()); assertNull(gems(capabilityCurrent = false))
    }
    @Test fun `saved smelt basket stays with original receipt owner`() {
        val s = contribution(); val v = s.view!!.copy(pool = "deed", dailyCapValue = null, remainingValue = null)
        val command = MiningContributionCommand.review(miningIdentity, v,
            "00000000-0000-4000-8000-000000000002", listOf(MiningContributionLine(v.resources.first().resourceId, "1")))
        assertNotNull(smelt(s.copy(view = v)))
        assertNull(smelt(s.copy(view = v, journal = s.journal.copy(operation = MiningContributionOperation(command, null, null, null)))))
    }

}
