package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.*
import org.junit.Assert.*
import org.junit.Test

/** Lantern5f9b5138: unknown and recovery observations must never imply a new order. AUTHORED/UNRUN. */
class WorkshopMoneyKitGateTest {
    private fun known() = WorkshopIngotsUi(IngotInventoryUi(3, 0),
        IngotAllowanceUi(IngotDailyUi(2, 11, 9), IngotHoldingUi(3, 0, 20, 17), null),
        7, IngotBatchUi(5), null, 100, true, null)
    private fun unknown() = known().copy(inventory = IngotInventoryUi(null, null),
        allowance = IngotAllowanceUi(IngotDailyUi(null, null, null), IngotHoldingUi(null, null, null, null), null),
        batch = IngotBatchUi(null), shards = null, shardsPerIngot = null, actionsAllowed = false)
    @Test fun `ready collect respects closed actions gate`() {
        val ui = known().copy(job = IngotJobUi("job", 2, null, IngotJobState.READY), actionsAllowed = false)
        val look = ingotsPrimary(ui, 0); assertEquals(CommandState.DISABLED, look.state)
        assertNotEquals(PrimaryAction.COLLECT, look.action)
    }
    @Test fun `collect retry cannot bypass a closed gate`() {
        val look = ingotsPrimary(known().copy(collect = CollectStage.FAILED, actionsAllowed = false), 0)
        assertEquals(CommandState.DISABLED, look.state); assertNotEquals(PrimaryAction.COLLECT, look.action)
    }
    @Test fun `admitted ready collect keeps existing action`() {
        assertEquals(PrimaryAction.COLLECT, ingotsPrimary(known().copy(job = IngotJobUi("job", 2, null, IngotJobState.READY)), 0).action)
    }
    @Test fun `unknown Shards are checking rather than sufficient funds`() {
        assertEquals(PriceStatus.CHECKING, shardsPrice(7, null)!!.status)
        assertEquals(PriceStatus.CHECKING, ingotsPrimary(known().copy(shards = null), 0).price!!.status)
    }
    @Test fun `known Shards keep exact short and sufficient cases`() {
        assertEquals(PriceStatus.SHORT, shardsPrice(7, 6)!!.status)
        assertEquals(PriceStatus.OK, shardsPrice(7, 7)!!.status)
    }
    @Test fun `unknown bench never says empty or paused and does not look in flight`() {
        val ui = unknown(); assertEquals("unknown", ingotsBenchLabel(ui))
        val look = ingotsPrimary(ui, 0); assertEquals(CommandState.DISABLED, look.state)
        assertNotEquals(CommandState.BUSY, look.state)
        assertFalse(look.reason.orEmpty().contains("paused", true))
        assertTrue(ingotsBenchUnknownText(ui).contains("not been confirmed"))
    }
    @Test fun `confirmed empty inventory may honestly show empty bench`() {
        assertEquals("empty", ingotsBenchLabel(known())); assertTrue(ingotsObservationKnown(known()))
    }
    @Test fun `saved original takes precedence over retained empty snapshot`() {
        val ui = known().copy(saved = SavedOpUi("original"))
        assertFalse(ingotsObservationKnown(ui)); assertEquals("unknown", ingotsBenchLabel(ui))
        assertNotEquals(PrimaryAction.START, ingotsPrimary(ui, 0).action)
        val look = ingotsPrimary(ui, 0)
        assertEquals("CAST", look.label); assertNull(look.sub) // Recovery has no admitted new quantity/duration.
        val afterReadError = ingotsPrimary(ui.copy(hydration = CraftHydration.Error("x")), 0)
        assertNotEquals(PrimaryAction.RETRY, afterReadError.action)
        assertEquals("Check the original receipt first.", afterReadError.reason)
        assertEquals(CommandState.DISABLED, afterReadError.state)
    }
    @Test fun `unbound recovery never falls back to generic saved callback`() {
        var generic = 0; val ui = known().copy(saved = SavedOpUi("original"))
        val on = WorkshopSheetActions(onCheckSaved = { generic++ })
        assertNull(ingotsOriginalCheck(ui, on)); assertEquals(0, generic)
    }
    @Test fun `recovery invokes only original read-only callback with exact saved key`() {
        val seen = mutableListOf<String>(); var generic = 0
        val ui = known().copy(saved = SavedOpUi("original"))
        val on = WorkshopSheetActions(onCheckSaved = { generic++ }, ingots = WorkshopIngotsActions(onCheckOriginalReceipt = { seen += it }))
        val check = requireNotNull(ingotsOriginalCheck(ui, on)); check("different"); check("original")
        assertEquals(listOf("original"), seen); assertEquals(0, generic)
    }
    @Test fun `checking original cannot dispatch another read`() {
        val ui = known().copy(saved = SavedOpUi("original", checking = true))
        assertNull(ingotsOriginalCheck(ui, WorkshopSheetActions(ingots = WorkshopIngotsActions(onCheckOriginalReceipt = { fail("second read") }))))
    }
    @Test fun `retained collect success keeps its evidence without offering another collect`() {
        val look = ingotsPrimary(known().copy(collect = CollectStage.COLLECTED, actionsAllowed = false), 0)
        assertEquals("COLLECTED", look.label); assertEquals(PrimaryAction.NONE, look.action)
    }
    @Test fun `saved original preserves actual sending evidence without generic retry`() {
        val ui = known().copy(saved = SavedOpUi("original"), hydration = CraftHydration.Error("x"),
            submit = SubmitUi(SubmitStage.SENDING, busyLabel = "Sending original"))
        val look = ingotsPrimary(ui, 0)
        assertEquals(CommandState.BUSY, look.state); assertEquals("Sending original", look.label)
        assertEquals(PrimaryAction.NONE, look.action)
    }
    @Test fun `saved original preserves actual checking evidence without generic retry`() {
        val ui = known().copy(saved = SavedOpUi("original"), submit = SubmitUi(SubmitStage.CHECKING))
        val look = ingotsPrimary(ui, 0)
        assertEquals(CommandState.BUSY, look.state); assertEquals("Being checked", look.label)
        assertEquals(PrimaryAction.NONE, look.action)
    }

}
