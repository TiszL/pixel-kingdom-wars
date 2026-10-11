package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.InfoPrimaryKind
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.InfoTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.InfoLoad
import gg.pixelkingdomwars.nativeclient.ui.sheets.editor.infoPrimaryTap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The live INFO sheet (BuildingFacts -> BuildingInfoUi). Why it matters: INFO is the first door on every building. It must
 * quote the upgrade exactly as the current sheet did (a different number on the same building is a trust bug), never put
 * a KEEP / Gems / SOL amount on screen (those reviews own their amounts), never claim a shortfall it cannot know, and its
 * primary must only navigate (to the review or to the existing finish path), never spend.
 */
class LiveInfoMapperTest {
    @Test fun `the upgrade chip quotes the current sheet's Shards amount and the next level`() {
        val ui = liveBuildingInfoUi(towerFacts())
        assertEquals(PriceUi(Currency.SHARDS, "521", PriceStatus.OK), ui.price)
        assertEquals("1h 30m", ui.time)
        assertEquals("1/2 free", ui.builders)
        assertEquals(InfoPrimaryKind.UPGRADE, ui.primary.kind)
        assertEquals("UPGRADE TO LV 5", ui.primary.label)
        assertEquals("at LV 5", ui.nextLegend)
        assertEquals("the primary opens the review, it never sends", InfoTap.UPGRADE,
            infoPrimaryTap(InfoLoad.READY, ui.primary.kind, ui.primary.state, ui.primary.price))
    }

    @Test fun `a known balance below the price shows SHORT with the exact shortfall, an unknown balance never does`() {
        val short = liveBuildingInfoUi(towerFacts(shardsBalance = "341"))
        assertEquals(PriceStatus.SHORT, short.price?.status)
        assertEquals("180", short.shortfall)
        assertEquals("UPGRADE TO LV n stays enabled navigation while short", CommandState.ENABLED, short.primary.state)
        val unknown = liveBuildingInfoUi(towerFacts(shardsBalance = null))
        assertEquals(PriceStatus.OK, unknown.price?.status)
        assertNull(unknown.shortfall)
    }

    @Test fun `a missing upgrade price is unavailable and the primary says why`() {
        val ui = liveBuildingInfoUi(towerFacts(upgradePriced = false))
        assertEquals(PriceStatus.UNAVAILABLE, ui.price?.status)
        assertNull("an unavailable price never draws an amount", ui.price?.amount)
        assertEquals(CommandState.DISABLED, ui.primary.state)
        assertEquals("Price unavailable right now", ui.primary.reason)
    }

    @Test fun `a SOL step shows no price on this sheet and still opens the current review`() {
        val ui = liveBuildingInfoUi(towerFacts(paidStep = true, paidOfferReady = true))
        assertNull(ui.price); assertNull(ui.time); assertNull(ui.builders)
        assertEquals(CommandState.ENABLED, ui.primary.state)
        assertEquals("Paid step · review before paying", ui.primary.sub)
        assertFalse("no SOL amount anywhere", ui.toString().contains("SOL "))
    }

    @Test fun `a running job turns the primary into FINISH without a price pill, on the existing finish path`() {
        val ui = liveBuildingInfoUi(towerFacts(job = upgradeJob()))
        assertEquals(InfoPrimaryKind.FINISH, ui.primary.kind)
        assertEquals("REVIEW FINISH", ui.primary.label)
        assertNull("the KEEP / Gems amount is the currency review's", ui.primary.price)
        assertNull(ui.price)
        assertTrue(ui.upgrading)
        assertEquals("UPGRADING 1h 12m", ui.stateTag.text)
        assertEquals(InfoTap.FINISH, infoPrimaryTap(InfoLoad.READY, ui.primary.kind, ui.primary.state, ui.primary.price))
        val free = liveBuildingInfoUi(towerFacts(job = upgradeJob(freeFinish = true, canReview = false)))
        assertEquals("FINISH NOW · FREE", free.primary.label)
        val unreadable = liveBuildingInfoUi(towerFacts(job = upgradeJob(canReview = false)))
        assertEquals(CommandState.DISABLED, unreadable.primary.state)
        assertEquals("Finish price unavailable", unreadable.primary.reason)
    }

    @Test fun `the fifth action is the server's refundable cancel, else the wall row toggle`() {
        val cancel = liveBuildingInfoUi(towerFacts(job = upgradeJob(refund = "260")))
        assertEquals(InfoExtraKind.CANCEL_JOB, liveInfoExtraKind(towerFacts(job = upgradeJob(refund = "260"))))
        assertEquals("Cancel upgrade · +260 Shards", cancel.extra?.label)
        assertNull("no refund offered, no cancel", liveInfoExtraKind(towerFacts(job = upgradeJob(refund = null))))
        assertNull("the current CANCEL is off while orders are blocked; so is this", liveInfoExtraKind(towerFacts(job = upgradeJob(), enabled = false)))
        val wall = towerFacts(type = "wall", category = BuildingCategory.WALL)
        assertEquals(InfoExtraKind.TOGGLE_ROW, liveInfoExtraKind(wall))
        assertEquals("Select whole row", liveBuildingInfoUi(wall).extra?.label)
        assertEquals("Select single wall", liveBuildingInfoUi(wall.copy(wallRow = true)).extra?.label)
        assertNull("the ROW toggle is off while busy", liveInfoExtraKind(wall.copy(busy = true)))
    }

    @Test fun `a spent trap opens its rearm review and max level is a plate, not a button`() {
        val trap = liveBuildingInfoUi(towerFacts(repair = RepairFact("1,250", "2h"), category = BuildingCategory.TRAP))
        assertEquals("REARM TRAP", trap.primary.label)
        assertEquals("1,250 Shards · 2h", trap.primary.sub)
        assertEquals(InfoTagUiExpect("SPENT", Verb.RED), InfoTagUiExpect(trap.stateTag.text, trap.stateTag.verb))
        val max = liveBuildingInfoUi(towerFacts(level = 10, canShowUpgrade = false, stats = listOf(StatFact("HP", "900", null))))
        assertEquals(InfoPrimaryKind.MAX, max.primary.kind)
        assertNull(max.nextLegend); assertNull(max.price)
    }

    @Test fun `a blocked base keeps the door visible and says why`() {
        val ui = liveBuildingInfoUi(towerFacts(enabled = false, readOnly = true))
        assertEquals(CommandState.DISABLED, ui.primary.state)
        assertEquals("Orders are paused here", ui.primary.reason)
    }

    @Test fun `stats are the table's values verbatim, a value that does not change is single`() {
        val ui = liveBuildingInfoUi(towerFacts())
        assertEquals(listOf("Hitpoints", "Damage per second", "Range"), ui.stats.map { it.label })
        assertEquals("430", ui.stats[0].next)
        assertNull(ui.stats[2].next)
        assertNull("next equal to now is not a change", infoStat(StatFact("CAP", "20", "20")).next)
        assertEquals("shape:info" to "XYZ", statLook("XYZ"))
    }

    private data class InfoTagUiExpect(val text: String, val verb: Verb)
}
