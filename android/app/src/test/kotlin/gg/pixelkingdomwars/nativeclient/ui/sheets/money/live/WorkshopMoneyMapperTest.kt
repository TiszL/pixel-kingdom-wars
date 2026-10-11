package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.WorkshopReview
import gg.pixelkingdomwars.nativeclient.data.WorkshopState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.*
import gg.pixelkingdomwars.nativeclient.workshop.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic server observations exercise money/currentness boundaries; no game costs are copied. */
class WorkshopMoneyMapperTest {
    @Test fun `default shell has no observed money inventory or action`() {
        val ui = workshopMoneySheetUi()
        assertNull(ui.ingots)
        assertNull(ui.review)
        assertNull(ui.spend)
        assertNull(ui.celebration)
        assertTrue(ui.frame.tabs.isEmpty())
        assertFalse(ui.frame.history)
        assertNull(ui.header.sprite)
    }

    @Test fun `same identity without current repository admission is insufficient`() {
        assertNull(workshopMoneySheetUi(state(), IDENTITY, BASE, viewCurrent = true, balanceCurrent = true,
            availableTabs = listOf(WorkshopTab.INGOTS)).ingots)
    }

    @Test fun `retained view without owner freshness is never read as current`() {
        assertNull(workshopMoneySheetUi(state(), IDENTITY, BASE, repositoryCurrent = true,
            availableTabs = listOf(WorkshopTab.INGOTS)).ingots)
    }

    @Test fun `wallet origin and cluster each belong to the repository identity`() {
        IDENTITY.validate()
        listOf(IDENTITY.copy(wallet = SECOND_WALLET), IDENTITY.copy(origin = "https://other.example"),
            IDENTITY.copy(cluster = "mainnet-beta")).forEach {
            it.validate() // Valid alternate identities must fail equality, not the protocol validator.
            assertNull(workshopMoneySheetUi(state(), it, BASE, true, true, true,
                availableTabs = listOf(WorkshopTab.INGOTS)).ingots)
        }
    }

    @Test fun `selected base must match the admitted inventory`() {
        assertNull(project(state(), base = OTHER_BASE).ingots)
        assertNull(project(state(), base = null).ingots)
    }

    @Test fun `capability loss and in-flight refresh close current observations`() {
        assertNull(project(state().copy(advertised = false)).ingots)
        assertNull(project(state().copy(busy = true)).ingots)
    }

    @Test fun `view protocol is revalidated before any stock is displayed`() {
        val invalid = view().copy(allowance = view().allowance.copy(daily = WorkshopDaily(6, 2, 99)))
        assertNull(project(state(invalid)).ingots)
    }

    @Test fun `server zero recipe is invalid rather than a free cast`() {
        assertNull(project(state(view().copy(shardsPerIngot = 0))).ingots)
    }

    @Test fun `selected-base inventory and wallet-wide allowance stay separate`() {
        val ui = requireNotNull(project(state()).ingots)
        assertEquals(IngotInventoryUi(1, 1), ui.inventory)
        assertEquals(IngotHoldingUi(3, 2, 14, 9), ui.allowance.holding)
        assertEquals(IngotDailyUi(2, 6, 4), ui.allowance.daily)
        assertEquals(3L, ui.batch.size)
    }

    @Test fun `known zero inventory is retained as an observation`() {
        val v = view().copy(inventory = WorkshopInventory(BASE, 0, 0), holding = WorkshopLegacyHolding(0, 0, 0, 0, 14))
        assertEquals(IngotInventoryUi(0, 0), project(state(v)).ingots?.inventory)
    }

    @Test fun `admitted server unit price and exact funds are projected without enabling cast`() {
        val ui = requireNotNull(project(state()).ingots)
        assertEquals(17L, ui.shardsPerIngot)
        assertEquals(999L, ui.shards)
        assertFalse(ui.actionsAllowed)
        assertEquals(CommandState.DISABLED, ingotsPrimary(ui, 0).state)
        assertFalse(ingotsPrimary(ui, 0).action in setOf(PrimaryAction.START, PrimaryAction.COLLECT))
    }

    @Test fun `unknown funds never inherit kits optimistic OK status`() {
        val ui = requireNotNull(project(state().copy(shards = null)).ingots)
        assertNull(ui.shards)
        assertNull(ui.shardsPerIngot)
        assertEquals(PriceStatus.CHECKING, ingotsPrimary(ui, 0).price?.status)
    }

    @Test fun `balance requires admission independently of current Workshop view`() {
        val ui = requireNotNull(workshopMoneySheetUi(state(), IDENTITY, BASE, true, true,
            availableTabs = listOf(WorkshopTab.INGOTS)).ingots)
        assertNull(ui.shards)
        assertEquals(PriceStatus.CHECKING, ingotsPrimary(ui, 0).price?.status)
    }

    @Test fun `invalid fractional and oversized funds remain unknown`() {
        listOf("-1", "+1", "1.0", " 1", "01", "9223372036854775808").forEach {
            val ui = requireNotNull(project(state().copy(shards = it)).ingots)
            assertNull(ui.shards)
            assertEquals(PriceStatus.CHECKING, ingotsPrimary(ui, 0).price?.status)
        }
    }

    @Test fun `zero funds are not confused with unknown`() {
        val ui = requireNotNull(project(state().copy(shards = "0")).ingots)
        assertEquals(0L, ui.shards)
        assertEquals(PriceStatus.SHORT, ingotsPrimary(ui, 0).price?.status)
    }

    @Test fun `exact-cost and one-short funds preserve the affordability boundary`() {
        listOf("17" to PriceStatus.OK, "16" to PriceStatus.SHORT).forEach { (funds, status) ->
            val ui = requireNotNull(project(state().copy(shards = funds)).ingots)
            assertEquals(17L, ui.shardsPerIngot)
            assertEquals(funds.toLong(), ui.shards)
            assertEquals(status, ingotsPrimary(ui, 0).price?.status)
            assertEquals(CommandState.DISABLED, ingotsPrimary(ui, 0).state)
            assertFalse(ingotsPrimary(ui, 0).action in setOf(PrimaryAction.START, PrimaryAction.COLLECT))
        }
    }

    @Test fun `Long MAX funds remain exact and affordable without enabling cast`() {
        val ui = requireNotNull(project(state().copy(shards = Long.MAX_VALUE.toString())).ingots)
        assertEquals(Long.MAX_VALUE, ui.shards)
        assertEquals(PriceStatus.OK, ingotsPrimary(ui, 0).price?.status)
        assertEquals(CommandState.DISABLED, ingotsPrimary(ui, 0).state)
    }

    @Test fun `server stopped accepting jobs keeps observations and closed primary`() {
        val ui = project(state(view().copy(acceptingJobs = false)))
        val ingots = requireNotNull(ui.ingots)
        assertEquals("Workshop paused", ui.frame.live?.text)
        assertEquals(IngotInventoryUi(1, 1), ingots.inventory)
        assertFalse(ingots.actionsAllowed)
        assertEquals(CommandState.DISABLED, ingotsPrimary(ingots, 0).state)
    }

    @Test fun `header art requires current view and admitted tier`() {
        assertNull(project(state()).header.sprite)
        assertNull(project(state(), base = OTHER_BASE, tier = 3).header.sprite)
        val stale = workshopMoneySheetUi(state(), IDENTITY, BASE, repositoryCurrent = true,
            availableTabs = listOf(WorkshopTab.INGOTS), headerTier = 3)
        assertNull(stale.header.sprite)
        assertNull(stale.header.loop)
    }

    @Test fun `admitted header tier uses idle running and ready server states`() {
        val idle = project(state(), tier = 3)
        assertEquals("craft:workshop_t3_idle", idle.header.sprite)
        assertNull(idle.header.loop)
        val running = project(state(view().copy(jobs = listOf(job(false)))), tier = 3)
        assertEquals("craft:workshop_t3_working", running.header.sprite)
        assertNotNull(running.header.loop)
        val ready = project(state(view().copy(jobs = listOf(job(true)))), tier = 4)
        assertEquals("craft:workshop_t4_ready", ready.header.sprite)
        assertNull(ready.header.loop)
        assertEquals(IngotJobState.READY, ready.ingots?.job?.state)
        assertFalse(requireNotNull(ready.ingots).actionsAllowed)
    }

    @Test fun `requested quantity is clamped only to observed server allowance`() {
        val ui = requireNotNull(project(state(), quantity = Int.MAX_VALUE).ingots)
        assertEquals(3, ui.quantity)
        assertEquals(1, project(state(), quantity = -9).ingots?.quantity)
    }

    @Test fun `overflowing price products never reach the kits Long multiplication`() {
        val v = hugeView().copy(shardsPerIngot = 9_007_199_254_740_991)
        val ui = requireNotNull(project(state(v), quantity = Int.MAX_VALUE).ingots)
        assertNull(ui.shardsPerIngot)
        assertEquals(PriceStatus.CHECKING, ingotsPrimary(ui, 0).price?.status)
    }

    @Test fun `overflowing duration products are unknown rather than wrapped`() {
        val ui = requireNotNull(project(state(hugeView().copy(secPerIngot = 9_007_199_254_740_991)), quantity = Int.MAX_VALUE).ingots)
        assertNull(ui.secondsPerIngot)
    }

    @Test fun `duration must also fit the entire observed running job`() {
        val hugeJob = job(false).copy(ingots = Int.MAX_VALUE.toLong(),
            shards = (17L * Int.MAX_VALUE).toString())
        val v = hugeView().copy(secPerIngot = 9_007_199_254_740_991, jobs = listOf(hugeJob))
        val ui = requireNotNull(project(state(v), quantity = 1).ingots)
        assertEquals(1, ui.quantity)
        assertNull(ui.secondsPerIngot)
        assertEquals(IngotJobState.RUNNING, ui.job?.state)
    }

    @Test fun `running status comes from server readiness not local countdown completion`() {
        val ui = requireNotNull(project(state(view().copy(jobs = listOf(job(false)))), offset = 0).ingots)
        assertEquals(IngotJobState.RUNNING, ui.job?.state)
        assertEquals(CommandState.BUSY, ingotsPrimary(ui, Long.MAX_VALUE / 2).state)
        assertEquals(CollectStage.IDLE, ui.collect)
    }

    @Test fun `unadmitted clock offset does not fabricate deadlines`() {
        val ui = requireNotNull(project(state(view().copy(jobs = listOf(job(false))))).ingots)
        assertNull(ui.job?.readyAtMs)
        assertNull(ui.job?.startedAtMs)
        assertNull(ui.allowance.resetsAtMs)
    }

    @Test fun `ready collect body preserves observed job while collection stays closed`() {
        val ui = project(state(view().copy(jobs = listOf(job(true)))))
        val ingots = requireNotNull(ui.ingots)
        assertEquals(IngotJobState.READY, ingots.job?.state)
        assertEquals(JOB, ingots.job?.jobId)
        assertEquals(IngotInventoryUi(1, 1), ingots.inventory)
        assertFalse(ingots.actionsAllowed)
        assertEquals(CommandState.DISABLED, ingotsPrimary(ingots, 0).state)
        assertNotEquals(PrimaryAction.COLLECT, ingotsPrimary(ingots, 0).action)
        assertTrue(ui.frame.live?.ready == true)
        assertNotNull(ui.frame.tabs.single().badge)
        assertNull(ui.review)
        assertNull(ui.celebration)
    }

    @Test fun `multiple uncollected jobs are not collapsed to a made-up single bench`() {
        val jobs = listOf(job(false), job(false).copy(jobId = OTHER_JOB))
        assertNull(project(state(view().copy(jobs = jobs))).ingots)
    }

    @Test fun `collected historical job does not become a new collected celebration`() {
        val v = view().copy(jobs = listOf(job(true).copy(collectedAt = NOW)))
        val ui = project(state(v))
        assertNull(ui.ingots?.job)
        assertEquals(CollectStage.IDLE, ui.ingots?.collect)
        assertNull(ui.celebration)
    }

    @Test fun `saved originals survive missing new-command capability and selected base`() {
        val original = savedState().copy(view = null, advertised = false)
        val ui = project(original, base = null)
        assertEquals("saved-original", ui.ingots?.saved?.opId)
        assertNull(ui.ingots?.inventory?.held)
        assertFalse(ui.ingots!!.actionsAllowed)
        assertFalse(ingotsPrimary(ui.ingots!!, 0).action in setOf(PrimaryAction.START, PrimaryAction.COLLECT))
    }

    @Test fun `saved original cannot leak across account identity`() {
        val secondIdentity = IDENTITY.copy(wallet = SECOND_WALLET)
        IDENTITY.validate()
        secondIdentity.validate()
        assertNull(workshopMoneySheetUi(savedState(), secondIdentity, BASE,
            true, true, true, availableTabs = listOf(WorkshopTab.INGOTS)).ingots)
    }

    @Test fun `ready observation preserves saved recovery precedence without enabling collect`() {
        val ui = project(savedState(collect = true), tier = 4)
        val ingots = requireNotNull(ui.ingots)
        assertEquals("saved-original", ingots.saved?.opId)
        assertEquals("Saved Workshop request needs attention", ui.frame.live?.text)
        assertFalse(ui.frame.live?.ready == true)
        assertNotNull(ui.frame.tabs.single().badge)
        assertEquals("craft:workshop_t4_ready", ui.header.sprite)
        assertNull(ingots.job)
        assertNull(ingots.inventory.held)
        assertEquals(CollectStage.IDLE, ingots.collect)
        assertFalse(ingotsPrimary(ingots, 0).action in setOf(PrimaryAction.START, PrimaryAction.COLLECT))
        assertNull(ui.review)
        assertNull(ui.celebration)
    }

    @Test fun `invalid saved original is never treated as an empty journal`() {
        val s = savedState()
        val original = requireNotNull(s.journal.operation)
        val invalid = original.copy(command = original.command.copy(key = ""))
        val ui = project(s.copy(journal = s.journal.copy(operation = invalid)))
        assertNull(ui.ingots)
        assertNull(ui.review)
        assertNull(ui.spend)
        assertEquals("Saved Workshop request needs attention", ui.frame.live?.text)
    }

    @Test fun `saved request stays visible while original receipt check is busy`() {
        val ui = requireNotNull(project(savedState().copy(busy = true)).ingots)
        assertEquals("saved-original", ui.saved?.opId)
        assertTrue(ui.saved?.checking == true)
        assertFalse(ingotsPrimary(ui, 0).action in setOf(PrimaryAction.START, PrimaryAction.COLLECT))
    }

    @Test fun `saved start and saved collect never fabricate a success or refusal`() {
        listOf(savedState(), savedState(collect = true)).forEach {
            val ui = project(it)
            assertEquals(SubmitStage.IDLE, ui.ingots?.submit?.stage)
            assertEquals(CollectStage.IDLE, ui.ingots?.collect)
            assertNull(ui.review)
            assertNull(ui.celebration)
            assertNull(ui.spend)
        }
    }

    @Test fun `repository review is not converted to an unreviewed confirmation sheet`() {
        val s = state(); val v = requireNotNull(s.view)
        val review = WorkshopReview(WorkshopCommand.start(v, "reviewed-key", 1), v, "999", 0, 0, 0, 0)
        assertNull(project(s.copy(review = review)).review)
    }

    @Test fun `only owner-admitted tabs and history are exposed`() {
        val ui = workshopMoneySheetUi(state(), IDENTITY, BASE, true, true, true,
            availableTabs = listOf(WorkshopTab.INGOTS), selectedTab = WorkshopTab.COSMETICS, historyAvailable = true)
        assertEquals(listOf(WorkshopTab.INGOTS), ui.frame.tabs.map { it.id })
        assertEquals(WorkshopTab.INGOTS, ui.frame.selectedTab)
        assertTrue(ui.frame.history)
        assertNull(ui.refine); assertNull(ui.tools); assertNull(ui.style)
    }

    @Test fun `saved recovery survives gated INGOTS without leaking a current-base body`() {
        listOf(listOf(WorkshopTab.REFINE), emptyList()).forEach { available ->
            val ui = workshopMoneySheetUi(savedState(), IDENTITY, BASE, true, true, true,
                availableTabs = available, selectedTab = WorkshopTab.REFINE)
            val ingots = requireNotNull(ui.ingots)
            assertEquals(available + WorkshopTab.INGOTS, ui.frame.tabs.map { it.id })
            assertEquals(WorkshopTab.INGOTS, ui.frame.selectedTab)
            assertEquals("saved-original", ingots.saved?.opId)
            assertEquals(IngotInventoryUi(null, null), ingots.inventory)
            assertEquals(IngotDailyUi(null, null, null), ingots.allowance.daily)
            assertEquals(IngotHoldingUi(null, null, null, null), ingots.allowance.holding)
            assertNull(ingots.batch.size)
            assertNull(ingots.job)
            assertNull(ingots.shards)
            assertNull(ingots.shardsPerIngot)
            assertNull(ui.frame.titleTag)
            assertFalse(ingots.actionsAllowed)
            assertFalse(ingotsPrimary(ingots, 0).action in setOf(PrimaryAction.START, PrimaryAction.COLLECT))
            assertNull(ui.refine); assertNull(ui.tools); assertNull(ui.style)
            assertNull(ui.review); assertNull(ui.spend); assertNull(ui.celebration)
        }
    }

    @Test fun `absent INGOTS admission without saved original cannot expose its current body`() {
        val ui = workshopMoneySheetUi(state(), IDENTITY, BASE, true, true, true,
            availableTabs = listOf(WorkshopTab.REFINE))
        assertNull(ui.ingots)
        assertEquals(listOf(WorkshopTab.REFINE), ui.frame.tabs.map { it.id })
    }

    private fun project(s: WorkshopState, base: String? = BASE, quantity: Int = 1, offset: Long? = null, tier: Int? = null) =
        workshopMoneySheetUi(s, IDENTITY, base, true, true, true, availableTabs = listOf(WorkshopTab.INGOTS),
            quantity = quantity, serverOffsetMs = offset, headerTier = tier)

    private fun state(v: WorkshopView = view()) = WorkshopState(
        WorkshopJournal(1, IDENTITY, 0, null, emptyList()), view = v, shards = "999", advertised = true)

    private fun savedState(collect: Boolean = false): WorkshopState {
        val v = if (collect) view().copy(jobs = listOf(job(true))) else view()
        val command = if (collect) WorkshopCommand.collect(v, "saved-original", JOB)
            else WorkshopCommand.start(v, "saved-original", 1)
        val s = state(v)
        return s.copy(journal = s.journal.copy(operation = WorkshopOperation(command, true, null, null)))
    }

    private fun hugeView() = view().copy(batch = WorkshopBatch(Int.MAX_VALUE.toLong(), Int.MAX_VALUE.toLong()),
        allowance = view().allowance.copy(daily = WorkshopDaily(Int.MAX_VALUE.toLong(), 0, Int.MAX_VALUE.toLong()),
            holding = WorkshopHolding(0, 0, 0, 0, Int.MAX_VALUE.toLong(), Int.MAX_VALUE.toLong())),
        dailyRefineCap = Int.MAX_VALUE.toLong(), holding = WorkshopLegacyHolding(1, 0, 0, 1, Int.MAX_VALUE.toLong()))

    private fun view() = WorkshopView(WorkshopFeatures(WorkshopFeature(1, 1, 1)), true, 1, 1, 17,
        WorkshopBatch(3, 9), 61, WorkshopInventory(BASE, 1, 1),
        WorkshopAllowance(1, "free_wallet", "2026-09-21T00:00:00.000Z", "2026-09-22T00:00:00.000Z", 2,
            WorkshopDaily(6, 2, 4), WorkshopHolding(3, 2, 0, 0, 14, 9)),
        6, 1, WorkshopLegacyHolding(1, 0, 0, 1, 14), 2, emptyList(), NOW)

    private fun job(ready: Boolean) = WorkshopJob(JOB, 1, "17", 1, 1,
        "2026-09-21T00:00:00.000Z", if (ready) "2026-09-21T00:01:01.000Z" else "2026-09-21T13:00:00.000Z", ready, null)

    private companion object {
        val IDENTITY = WorkshopIdentity("https://example.invalid", "devnet", "11111111111111111111111111111111")
        const val SECOND_WALLET = "11111111111111111111111111111112"
        const val BASE = "00000000-0000-4000-8000-000000000001"
        const val OTHER_BASE = "00000000-0000-4000-8000-000000000003"
        const val JOB = "00000000-0000-4000-8000-000000000002"
        const val OTHER_JOB = "00000000-0000-4000-8000-000000000004"
        const val NOW = "2026-09-21T12:00:00.000Z"
    }
}
