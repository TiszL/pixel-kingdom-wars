package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.UpgradePrimaryKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.UpgradeState
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.upgradePrimaryLook
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The live UPGRADE review (BuildingFacts -> UpgradeSheetUi) and the Shards Need-more. Why it matters: this sheet replaces
 * the review that spends Shards. It may send only where the current sheet's UPGRADE plate sent (same price, same gates),
 * must hand every money path (SOL step, rearm, running job) back to the current sheet, must never look like it is
 * sending when it is not, and SHORT must lead to the place that earns Shards, never to a spend.
 */
class LiveUpgradeMapperTest {
    @Test fun `a payable Shards upgrade is READY and sends at the current sheet's price`() {
        val ui = assertNotNullUi(liveUpgradeUi(towerFacts()))
        assertEquals(UpgradeState.READY, ui.state)
        assertEquals("521", ui.price.amount)
        assertEquals(Currency.SHARDS, ui.price.currency)
        assertEquals("LV 4", ui.levelFrom); assertEquals("LV 5", ui.levelTo)
        assertTrue(ui.newLook)
        assertEquals(listOf("Hitpoints", "Damage per second"), ui.rows.map { it.label })
        assertTrue(upgradePrimaryLook(ui.state, ui.price, ui.reason).sends)
    }

    @Test fun `money paths and non-upgrades stay on the current sheet`() {
        assertNull("SOL step", liveUpgradeUi(towerFacts(paidStep = true, paidOfferReady = true)))
        assertNull("rearm", liveUpgradeUi(towerFacts(repair = RepairFact("1,250", "2h"))))
        assertNull("running job", liveUpgradeUi(towerFacts(job = upgradeJob())))
        assertNull("no upgrade to show", liveUpgradeUi(towerFacts(canShowUpgrade = false)))
    }

    @Test fun `short of Shards shows the exact shortfall and the Mines door, and cannot send`() {
        val ui = assertNotNullUi(liveUpgradeUi(towerFacts(shardsBalance = "341")))
        assertEquals(UpgradeState.SHORT, ui.state)
        assertEquals(PriceStatus.SHORT, ui.price.status)
        assertEquals("180", ui.shortfall)
        assertEquals("Mines hold 8,400", ui.bestDoor?.label)
        assertEquals(LiveDoors.MINES, ui.bestDoor?.destination)
        val look = upgradePrimaryLook(ui.state, ui.price, ui.reason)
        assertEquals(UpgradePrimaryKind.NEED_MORE, look.kind)
        assertFalse(look.sends)
        assertEquals("no mine yet: build one", LiveDoors.BUILD,
            liveUpgradeUi(towerFacts(shardsBalance = "1", mine = MineFact(null, null)))?.bestDoor?.destination)
    }

    @Test fun `an unknown balance is never a shortfall`() {
        assertEquals(UpgradeState.READY, liveUpgradeUi(towerFacts(shardsBalance = null))?.state)
        assertNull(shortfall(null, "521")); assertNull(shortfall("600", null))
        assertNull("enough", shortfall("521", "521"))
        assertEquals("1", shortfall("520", "521"))
        assertNull("garbage is unknown, not zero", shortfall("abc", "521"))
    }

    @Test fun `no free builder routes to Builders with the next free time`() {
        val ui = assertNotNullUi(liveUpgradeUi(towerFacts(freeBuilders = 0, nextBuilderFreeIn = "2h 14m")))
        assertEquals(UpgradeState.NO_BUILDER, ui.state)
        assertEquals("2h 14m", ui.builderFreeIn)
        assertEquals("0/2 free", ui.builders)
        assertFalse(upgradePrimaryLook(ui.state, ui.price, ui.reason).sends)
    }

    @Test fun `only this sheet's own press reads Starting, any other busy is off with Working`() {
        assertEquals(UpgradeState.BUSY, liveUpgradeUi(towerFacts(busy = true, enabled = false), sent = true)?.state)
        val other = assertNotNullUi(liveUpgradeUi(towerFacts(busy = true, enabled = false), sent = false))
        assertEquals(UpgradeState.READ_ONLY, other.state)
        assertEquals("Working…", other.reason)
        assertFalse(upgradePrimaryLook(other.state, other.price, other.reason).sends)
    }

    @Test fun `a paused base or a saved construction payment cannot send and says why`() {
        val paused = assertNotNullUi(liveUpgradeUi(towerFacts(enabled = false, readOnly = true)))
        assertEquals(UpgradeState.READ_ONLY, paused.state); assertEquals("Orders are paused here", paused.reason)
        val saved = assertNotNullUi(liveUpgradeUi(towerFacts(enabled = false, constructionBlocked = true)))
        assertEquals("Check the saved payment first", saved.reason)
    }

    @Test fun `an unavailable price is drawn off with a reason, never as zero`() {
        val ui = assertNotNullUi(liveUpgradeUi(towerFacts(upgradePriced = false)))
        assertEquals(PriceStatus.UNAVAILABLE, ui.price.status); assertNull(ui.price.amount)
        val look = upgradePrimaryLook(ui.state, ui.price, ui.reason)
        assertEquals(UpgradePrimaryKind.OFF, look.kind); assertFalse(look.sends)
    }

    @Test fun `need-more lists have, need and more, and only navigates`() {
        val more = assertNotNullMore(liveUpgradeNeedMore(towerFacts(shardsBalance = "341")))
        assertEquals("Archer Tower LV 5", more.forLabel)
        val block = more.blocks.single()
        assertEquals("341", block.have); assertEquals("521", block.need); assertEquals("180", block.more)
        assertEquals("GO TO MINES", more.best.label)
        assertEquals("8,400 Shards ready to collect", more.best.hint)
        assertNull("nothing missing, no sheet", liveUpgradeNeedMore(towerFacts()))
        assertNull("SOL step is not this sheet's", liveUpgradeNeedMore(towerFacts(shardsBalance = "1", paidStep = true)))
        assertFalse("Gems -> Shards is a money path and is not offered", more.toString().contains("GEMS"))
    }

    @Test fun `a need-more door selects the Mine or opens the BUILD tray`() {
        assertEquals("mine-1", needMoreDoorTarget(LiveDoors.MINES, MineFact("mine-1", null)))
        assertNull(needMoreDoorTarget(LiveDoors.MINES, MineFact(null, null)))
        assertNull(needMoreDoorTarget(LiveDoors.BUILD, MineFact("mine-1", null)))
        assertNull(needMoreDoorTarget(FeatureId("other"), MineFact("mine-1", null)))
    }

    private fun assertNotNullUi(ui: gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.UpgradeSheetUi?) = ui.also { assertNotNull(it) }!!
    private fun assertNotNullMore(ui: gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.NeedMoreUi?) = ui.also { assertNotNull(it) }!!
}
