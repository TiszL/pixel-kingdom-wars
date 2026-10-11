package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.network.BasePurchaseOffer
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseAccepted
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseArt
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseCanFinish
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseFeeLine
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseSol
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseTitle
import org.junit.Assert.*
import org.junit.Test

class BasePurchasePresentationTest {
    @Test fun `wallet review preserves every lamport without floating point or locale rounding`() {
        assertEquals("0.000000001", basePurchaseSol("1"))
        assertEquals("0.5", basePurchaseSol("500000000"))
        assertEquals("9007199.254740991", basePurchaseSol("9007199254740991"))
    }

    @Test fun `unknown quote cannot be discarded even before wallet attempt`() {
        assertFalse(basePurchaseCanFinish(null, false, false, false, null))
        assertFalse(basePurchaseCanFinish("pending", false, false, false, null))
        assertFalse(basePurchaseCanFinish("pending", true, false, false, null))
    }

    @Test fun `failed or expired wallet attempts remain recoverable instead of masquerading as unpaid cancellations`() {
        listOf("failed", "expired").forEach { status ->
            assertFalse(basePurchaseCanFinish(status, true, false, false, null))
            assertTrue(basePurchaseCanFinish(status, false, false, false, null))
        }
    }

    @Test fun `accepted receipt requires original hydration or explicit original deed unavailability before Finish`() {
        assertFalse(basePurchaseCanFinish("credited", true, false, true, null))
        assertFalse(basePurchaseCanFinish("credited", true, true, false, null))
        assertFalse(basePurchaseCanFinish("credited", true, true, false, " "))
        assertTrue(basePurchaseCanFinish("credited", true, true, true, null))
        assertTrue(basePurchaseCanFinish("credited", true, true, false, "The original deed is no longer available."))
    }

    /** The hero line is the SOL price; its small second line carries what else the price buys, and never a raw identifier. */
    @Test fun `the fee line under the hero amount states the Shards, energy, duration and fee split in one line`() {
        val mine = BasePurchaseOffer("mine", "base-1", buildingId = "b-1", buildingType = "goldforge", fromLevel = 2, toLevel = 3, amountLamports = "2000000000", maxCostShards = "1500", seconds = "5400")
        assertEquals("+ UP TO 1500 SHARDS · BUILD 1H 30M", basePurchaseFeeLine(mine))
        assertEquals("A quoted cost replaces the ceiling; the fee estimate joins in SOL", "+ 1200 SHARDS QUOTED · BUILD 1H 30M · NETWORK FEE ≈ 0.000005 SOL", basePurchaseFeeLine(mine, "1200", "5000"))
        val energy = BasePurchaseOffer("energy", "base-1", amountLamports = "500000000", energyQuantity = 5)
        assertEquals("+5 RAID ENERGY", basePurchaseFeeLine(energy))
        assertEquals("SHIELD 2H", basePurchaseFeeLine(BasePurchaseOffer("shield", "base-1", amountLamports = "1", seconds = "7200")))
        assertNull("Nothing to add for a plain expansion", basePurchaseFeeLine(BasePurchaseOffer("expansion", "base-1", expectedCount = 1, amountLamports = "2000000000")))
        assertEquals("map", basePurchaseArt("expansion")); assertEquals("building-goldforge", basePurchaseArt("mine", "goldforge")); assertEquals("energy", basePurchaseArt("energy_pack"))
    }

    @Test fun `paid mine receipt promises construction acceptance rather than an already ready level`() {
        assertEquals("GOLD FORGE upgrade", basePurchaseTitle("mine", "goldforge"))
        // Rewritten 2026-09-18 to the short game copy (owner: "simple, as in most games"). Unchanged rule: a paid mine
        // upgrade is reported as STARTED with a timer still to run, never as an already-ready level. The deed and building
        // identifiers moved under the plate's DETAILS ("Original deed" / "Original building").
        assertTrue(basePurchaseAccepted("mine").contains("UPGRADE STARTED")); assertTrue(basePurchaseAccepted("mine").contains("build timer finishes"))
        assertFalse(basePurchaseAccepted("mine").contains("READY NOW"))
        assertEquals("BUILDER HIRED.", basePurchaseAccepted("builder")); assertEquals("LAND EXPANDED.", basePurchaseAccepted("expansion"))
    }
}
