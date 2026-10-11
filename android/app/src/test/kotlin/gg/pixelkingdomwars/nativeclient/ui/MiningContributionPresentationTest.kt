package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.MiningContributionState
import gg.pixelkingdomwars.nativeclient.miningcontribution.*
import org.junit.Assert.*
import org.junit.Test

class MiningContributionPresentationTest {
    private val wallet = "11111111111111111111111111111111"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val view = MiningContributionView(wallet, base, 2, "2026-09-29", "2026-09-29T12:00:00.000Z", true, "free", "200", "0", "200", true,
        miningContributionResourceIds.map { MiningContributionStock(it, "100", "13") }, MiningConsistencyPolicy(3, 20, 60))
    private val identity = MiningContributionIdentity("https://example.test", "devnet", wallet)
    @Test fun `basket presents exact server values and rejects invalid unavailable or foreign resources`() {
        val lines = requireNotNull(miningBasket(view, mapOf("shards" to "2", "frost_quartz" to "3")))
        assertEquals("65", miningBasketTotal(view, lines).toString())
        for (map in listOf(mapOf("shards" to "101"), mapOf("shards" to "2.5"), mapOf("shards" to "01"), mapOf("gems" to "1"))) assertNull(miningBasket(view, map))
        assertTrue(requireNotNull(miningBasket(view, mapOf("shards" to "0"))).isEmpty())
    }
    @Test fun `entry remains available for saved receipts or unreadable encrypted storage while discovery is paused`() {
        val empty = MiningContributionState(MiningContributionJournal(1, identity, 0, null, emptyList()))
        assertFalse(miningContributionEntryAvailable(empty)); assertTrue(miningContributionEntryAvailable(null, true))
        assertTrue(miningContributionEntryAvailable(empty.copy(advertised = true)))
        val command = MiningContributionCommand.review(identity, view, base, listOf(MiningContributionLine("shards", "1")))
        assertTrue(miningContributionEntryAvailable(empty.copy(journal = empty.journal.copy(operation = MiningContributionOperation(command, null, null, null)))))
    }
    @Test fun `irreversible consent names reservation no cancellation and both whole-basket outcomes`() {
        assertTrue(MINING_CONTRIBUTION_CONSENT.contains("cannot be cancelled")); assertTrue(MINING_CONTRIBUTION_CONSENT.contains("whole basket is permanently consumed"))
        assertTrue(MINING_CONTRIBUTION_CONSENT.contains("whole basket is returned")); assertEquals("Gold Ingots", miningResourceLabel("forge_ingot"))
    }
    @Test fun `kit selection uses actual policy inventory and server value without resetting free allowance`() {
        val v3 = view.copy(policyVersion = 3, resources = miningContributionResourceIdsV3.map { MiningContributionStock(it, "100", "17") }, committedValue = "40", remainingValue = "160")
        val basket = requireNotNull(miningBasket(v3, mapOf("expedition_kit" to "2", "climate_kit" to "3")))
        assertEquals("85", miningBasketTotal(v3, basket).toString()); assertEquals("160", v3.remainingValue)
        assertNull(miningBasket(view, mapOf("expedition_kit" to "1")))
        assertEquals("Climate Kit", miningResourceLabel("climate_kit"))
    }

}
