package gg.pixelkingdomwars.nativeclient.ui.goldforge

import gg.pixelkingdomwars.nativeclient.data.EconomyState
import gg.pixelkingdomwars.nativeclient.data.GemsBuyDraft
import gg.pixelkingdomwars.nativeclient.data.GemsBuyState
import gg.pixelkingdomwars.nativeclient.data.MiningContributionState
import gg.pixelkingdomwars.nativeclient.data.SavedGemsBuy
import gg.pixelkingdomwars.nativeclient.miningcontribution.*
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.model.WithdrawalRecord
import gg.pixelkingdomwars.nativeclient.ui.features.*
import org.junit.Assert.*
import org.junit.Test

/** Written before the bounded fact adapter. Cedar3 alone executes these tests. */
class GoldForgeGateFactsTest {
    private val wallet = "11111111111111111111111111111112"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val identity = MiningContributionIdentity("https://example.invalid", "devnet", wallet)
    private fun contribution() = MiningContributionState(
        MiningContributionJournal(1, identity, 0, null, emptyList()),
        MiningContributionView(wallet, base, 3, "2026-10-05", "2026-10-05T04:00:00.000Z",
            true, "free", "100", "20", "80", true,
            miningContributionResourceIds(3).map { MiningContributionStock(it, "0", "7") },
            MiningConsistencyPolicy(7, 17, 119)), advertised = true)
    private fun purchase() = GemsBuyState(saved = SavedGemsBuy(
        GemsBuyDraft(wallet, "https://example.invalid", "devnet", "original-gems-key", 7)))
    private fun economy(keep: String = "23") = EconomyState(baseId = base, balances = Balances("0", keep))
    private fun withdrawal() = WithdrawalRecord(
        id = "00000000-0000-4000-8000-000000000002", status = "unbonding", gross = "200", fee = "3", net = "197",
        destination = wallet, createdAt = "2026-10-01T12:00:00Z", unbondsAt = "2026-10-04T12:00:00Z",
        signature = null, refundable = false, mint = null, completedAt = null)
    private fun facts(current: Boolean = true, supported: Boolean? = null, buy: GemsBuyState? = null,
        smelt: MiningContributionState? = null, value: EconomyState? = null, freshBalance: Boolean = false,
        selectedBase: String? = base) = goldForgeGateFacts(wallet, selectedBase, current, supported, buy, smelt, value, freshBalance)
    private fun resolve(id: String, facts: GoldForgeGateFacts): FeatureResolution = FeatureRegistry.canonical().resolve(
        FeatureId(id), GateContext(baseId = base, buildings = mapOf("goldforge" to BuildingGateState(1, true)),
            serverFeatures = facts.serverFeatures, history = facts.history))

    @Test fun `missing observations stay unknown and never invent legacy availability`() {
        val result = facts()
        assertEquals(setOf("gems", "gems.buyPending", "phaseE.miningContribution"), result.serverFeatures.keys)
        assertEquals(setOf("forge.owed", "forge.saved"), result.history.keys)
        assertTrue(result.serverFeatures.values.all { it == GateFact.Unknown })
        assertTrue(result.history.values.all { it == GateFact.Unknown })
        assertFalse(result.serverFeatures.containsKey("forge.legacyLive"))
    }

    @Test fun `retired session suppresses every retained fact including saved history`() {
        val result = facts(current = false, supported = true, buy = purchase(), smelt = contribution(),
            value = economy().copy(withdrawals = listOf(withdrawal())), freshBalance = true)
        assertTrue(result.serverFeatures.values.all { it == GateFact.Unknown })
        assertTrue(result.history.values.all { it == GateFact.Unknown })
    }

    @Test fun `Gems support is independent from the saved purchase recovery fact`() {
        assertEquals(GateFact.Allowed, facts(supported = true).serverFeatures["gems"])
        assertEquals(GateFact.Unknown, facts(supported = false).serverFeatures["gems"])
        val recovery = facts(supported = false, buy = purchase().copy(busy = true, available = false))
        assertEquals(GateFact.Unknown, recovery.serverFeatures["gems"])
        assertEquals(GateFact.Allowed, recovery.serverFeatures["gems.buyPending"])
        assertEquals(FeatureResolution.Navigate(Destination.GoldForge("GEMS")), resolve("goldforge.gems", recovery))
    }

    @Test fun `another wallet saved purchase cannot create a recovery door`() {
        val original = purchase()
        val wrong = original.copy(saved = original.saved!!.copy(draft = original.saved!!.draft.copy(wallet = "other")))
        assertEquals(GateFact.Unknown, facts(buy = wrong).serverFeatures["gems.buyPending"])
        assertEquals(FeatureResolution.Hidden, resolve("goldforge.gems", facts(buy = wrong)))
    }

    @Test fun `SMELT requires an advertised idle view for this exact wallet and kingdom`() {
        val result = facts(smelt = contribution())
        assertEquals(GateFact.Allowed, result.serverFeatures["phaseE.miningContribution"])
        assertEquals(FeatureResolution.Navigate(Destination.GoldForge("SMELT")), resolve("goldforge.smelt", result))
        val original = contribution()
        for (state in listOf(original.copy(advertised = false), original.copy(busy = true), original.copy(view = null),
            original.copy(view = original.view!!.copy(baseId = "other")), original.copy(view = original.view!!.copy(wallet = "other")),
            original.copy(journal = original.journal.copy(identity = identity.copy(wallet = "other"))))) {
            assertEquals(GateFact.Unknown, facts(smelt = state).serverFeatures["phaseE.miningContribution"])
        }
        assertEquals(GateFact.Unknown, facts(smelt = original, selectedBase = null).serverFeatures["phaseE.miningContribution"])
    }

    @Test fun `SMELT navigation does not pretend contribution holds are permissions`() {
        val held = contribution().let { it.copy(view = it.view!!.copy(acceptingContributions = false, developmentReady = false)) }
        assertEquals(GateFact.Allowed, facts(smelt = held).serverFeatures["phaseE.miningContribution"])
        assertFalse(facts(smelt = held).serverFeatures.values.any { it is GateFact.Denied })
    }

    @Test fun `retained withdrawals keep Legacy navigation after failed reads and base changes`() {
        val history = economy("0").copy(baseId = "other", loading = true,
            errors = mapOf("/withdrawals" to "offline", "/balances" to "offline"), withdrawals = listOf(withdrawal()))
        val result = facts(value = history)
        assertEquals(GateFact.Allowed, result.history["forge.owed"])
        assertEquals(GateFact.Unknown, result.history["forge.saved"])
        assertEquals(FeatureResolution.Navigate(Destination.GoldForge("LEGACY")), resolve("goldforge.legacy", result))
    }

    @Test fun `historical existence does not validate withdrawal status or grant return permission`() {
        val malformed = withdrawal().copy(status = "unknown", gross = "not-an-amount", signature = "invalid")
        assertEquals(GateFact.Allowed, facts(value = EconomyState(withdrawals = listOf(malformed))).history["forge.owed"])
        assertEquals(GateFact.Unknown, facts(value = EconomyState(withdrawals = emptyList())).history["forge.owed"])
    }

    @Test fun `saved custodial KEEP requires an explicit fresh balance witness`() {
        assertEquals(GateFact.Unknown, facts(value = economy()).history["forge.saved"])
        val result = facts(value = economy("9007199254740993.123"), freshBalance = true)
        assertEquals(GateFact.Allowed, result.history["forge.saved"])
        assertEquals(FeatureResolution.Navigate(Destination.GoldForge("LEGACY")), resolve("goldforge.legacy", result))
        assertFalse(result.serverFeatures.containsKey("forge.legacyLive"))
    }

    @Test fun `wrong base loading and failed balance reads cannot establish saved KEEP`() {
        for (state in listOf(economy().copy(baseId = "other"), economy().copy(loading = true),
            economy().copy(errors = mapOf("/balances" to "offline")), EconomyState(baseId = base))) {
            assertEquals(GateFact.Unknown, facts(value = state, freshBalance = true).history["forge.saved"])
        }
        assertEquals(GateFact.Unknown, facts(value = economy(), freshBalance = true, selectedBase = null).history["forge.saved"])
    }

    @Test fun `unknown zero negative and noncanonical balances are not saved history`() {
        for (amount in listOf("0", "0.000", "", "-1", "+1", "01", "1e3", "NaN", " 2 ", ".5", "1.")) {
            assertEquals(GateFact.Unknown, facts(value = economy(amount), freshBalance = true).history["forge.saved"])
        }
        assertEquals(GateFact.Allowed, facts(value = economy("0.0001"), freshBalance = true).history["forge.saved"])
    }

    @Test fun `wallet funds and an unrelated RPC error never substitute for custodial balance proof`() {
        val walletOnly = EconomyState(baseId = base, wallet = WalletFunds(null, mapOf("KEEP" to "999"), 0))
        assertEquals(GateFact.Unknown, facts(value = walletOnly, freshBalance = true).history["forge.saved"])
        assertEquals(GateFact.Allowed, facts(value = economy().copy(errors = mapOf("/wallet/balances" to "offline")),
            freshBalance = true).history["forge.saved"])
    }
}
