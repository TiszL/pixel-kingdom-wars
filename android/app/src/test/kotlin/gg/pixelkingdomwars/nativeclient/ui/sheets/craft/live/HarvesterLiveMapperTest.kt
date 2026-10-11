package gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live

import gg.pixelkingdomwars.nativeclient.data.HarvesterState
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterArchive
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterCommand
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterEvent
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterFacility
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterFeature
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterFeatures
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterIdentity
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterJournal
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterOperation
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterPolicy
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterProof
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterReceipt
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterRefusal
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterRequest
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterSettlement
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterSource
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterSummary
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterTerm
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterView
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionHome
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.towerFacts
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHydration
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.IntervalState
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.PrimaryAction
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SubmitStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.harvesterPrimary
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The live Harvester sheet must tell the truth about server-delivered hauls: every amount is a server observation (net of
 * the island pool), an unknown amount is "…" (null), never 0, and COLLECT is only the client's acknowledgement of what the
 * server already delivered. Authored for the Codex integrator; not run in this lane (no build tool).
 */
class HarvesterLiveMapperTest {
    private val wallet = "DaEy4YZ9xwiGzw1nTQVB1vxCTZRBQJhbmLU55BXQ2jgi"
    private val base = "12345678-1234-4678-9abc-def012345601"
    private val harvesterId = "12345678-1234-4678-9abc-def012345602"
    private val sourceId = "12345678-1234-4678-9abc-def012345603"
    private val identity = HarvesterIdentity("https://api.example.gg", "devnet", wallet)
    private val policy = HarvesterPolicy(1, 1, "48", "12", 21_600, 86_400, 1, 10_000, 500)
    private val admitted = "2030-01-01T00:00:00.000Z"
    private val lease = "2030-01-02T00:00:00.000Z"
    private fun ms(text: String) = Instant.parse(text).toEpochMilli()
    private val summary = HarvesterSummary(sourceId, base, harvesterId, 1, "crownlands", "crown_iron_ore", admitted, lease)
    private val facility = HarvesterFacility(base, harvesterId, "12345678-1234-4678-9abc-def012345604", "2029-12-31T00:00:00.000Z")
    private fun event(ordinal: Int, sequence: String, earnedAt: String, net: String = "11", gross: String = "12") =
        HarvesterEvent(sourceId, ordinal, sequence, "crown_iron_ore", 1, earnedAt, earnedAt.replace(":00.000Z", ":05.000Z"),
            earnedAt.substring(0, 10) + "T00:00:00.000Z", gross, net, "1", 1, 10_000, 500, "0", "0")
    private val command = HarvesterCommand(HarvesterRequest(sourceId, base, harvesterId, null, 1), facility, "crownlands", policy, null)
    private fun accepted(events: List<HarvesterEvent>, closed: Boolean = false) = HarvesterOperation(command, 1,
        HarvesterProof(wallet, sourceId, "2030-01-01T08:00:00.000Z", "accepted",
            HarvesterReceipt(wallet, command.request, HarvesterSource(sourceId, base, harvesterId, 1, "crownlands", "crown_iron_ore",
                admitted, lease, facility.completedBuildJobId, facility.harvesterCompletedAt,
                HarvesterTerm("12345678-1234-4678-9abc-def012345605", "0".repeat(64), "2029-12-01T00:00:00.000Z", "2030-02-01T00:00:00.000Z"), policy)),
            HarvesterSettlement(events, if (closed) gg.pixelkingdomwars.nativeclient.harvester.HarvesterClosure(sourceId, "lease_expired", lease, events.size) else null, null)),
        null)
    private fun viewOf(source: HarvesterSummary? = summary, accepting: Boolean = true, serverNow: String = "2030-01-01T08:00:00.000Z",
        facilities: List<HarvesterFacility> = listOf(facility)) = HarvesterView(wallet, base, serverNow, HarvesterFeatures(HarvesterFeature(1, 1)),
        accepting, StarterExpeditionHome("free_assignment", 1, "crownlands"), facilities, source, source, policy,
        listOf(OrdinaryRawStock("crown_iron_ore", "48", "0", "48")))
    private fun stateOf(view: HarvesterView? = viewOf(), operation: HarvesterOperation? = null, archives: List<HarvesterArchive> = emptyList(),
        busy: Boolean = false) = HarvesterState(HarvesterJournal(1, identity, 3, operation, archives), view, busy = busy, advertised = view != null)
    private val twoHauls = listOf(event(1, "4", "2030-01-01T06:00:00.000Z"), event(2, "5", "2030-01-01T12:00:00.000Z"))
    private val harvesterBuilding = towerFacts(type = "harvester", level = 2, maxLevel = 5, upgradeCost = "1,200", upgradeCostRaw = "1200",
        shardsBalance = "40943").copy(buildingId = harvesterId)
    private val now = ms("2030-01-01T08:00:00.000Z")

    private fun sheet(state: HarvesterState = stateOf(operation = accepted(twoHauls.take(1))), seen: String? = "4", nowMs: Long = now,
        actionsAllowed: Boolean = true, error: String? = null, tab: String? = null, building: gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.BuildingFacts? = harvesterBuilding) =
        harvesterLiveUi(tab, state, wallet, base, building, "crownlands", 2, seen, actionsAllowed, running = false, error = error,
            nowMs = nowMs, serverOffsetMs = 0L)

    @Test fun `gathering shows the server cadence grid, net arrivals today and real stock`() {
        val y = sheet().harvest
        assertEquals(IntervalState.RUNNING, y.interval.state)
        assertEquals("next haul is the next point on the server grid (admittedAt + n x cadence)", ms("2030-01-01T12:00:00.000Z"), y.interval.nextHaulAtMs)
        assertEquals("arrived today counts what reached the stores (net of the island pool), not gross", 11L, y.todayArrived)
        assertEquals(48L, y.stock.available)
        assertEquals(12L, y.policy.grossPerCadence)
        assertEquals("Crownlands", y.realmName); assertEquals("Crown Iron Ore", y.resourceName)
        assertNull("no server field gives the next level's gain, so none is invented", y.nextLevelDelta)
        assertEquals("refine_crownsteel", y.refineDoor?.id)
        assertEquals(PriceStatus.OK, y.upgradeCost?.status); assertEquals("1,200", y.upgradeCost?.amount)
        assertEquals(PrimaryAction.UPGRADE, harvesterPrimary(y)?.action)
    }

    @Test fun `an unseen haul turns the primary into COLLECT with the delivered amount and the ready sprite`() {
        val s = sheet(stateOf(operation = accepted(twoHauls)), seen = "4", nowMs = ms("2030-01-01T13:00:00.000Z"))
        assertEquals(11L, s.harvest.arrived.unseenQuantity)
        val primary = harvesterPrimary(s.harvest)!!
        assertEquals("COLLECT 11", primary.label)
        assertEquals(PrimaryAction.COLLECT, primary.action)
        assertTrue(s.header.sprite!!.endsWith("_ready"))
    }

    @Test fun `without a seen marker nothing is invented as arrived`() {
        val s = sheet(stateOf(operation = accepted(twoHauls)), seen = null)
        assertEquals(0L, s.harvest.arrived.unseenQuantity)
        assertEquals("5", harvesterLatestSequence(stateOf(operation = accepted(twoHauls)).journal, sourceId))
    }

    @Test fun `a source with no saved receipt reads arrivals as unknown, never zero`() {
        val y = sheet(stateOf(operation = null)).harvest
        assertNull(y.todayArrived)
        assertEquals(0L, y.arrived.unseenQuantity)
    }

    @Test fun `past the lease the interval has ENDED and an accepted receipt still to archive blocks START AGAIN`() {
        val late = ms("2030-01-02T01:00:00.000Z")
        val y = sheet(stateOf(operation = accepted(twoHauls)), seen = "5", nowMs = late).harvest
        assertEquals(IntervalState.ENDED, y.interval.state)
        assertTrue("the accepted receipt must be archived before a new interval", y.saved != null)
        val primary = harvesterPrimary(y)!!
        assertEquals("START AGAIN", primary.label)
        assertEquals(CommandState.DISABLED, primary.state)
    }

    @Test fun `no source means not gathering, and START follows the server's acceptingSelections`() {
        val open = sheet(stateOf(viewOf(source = null))).harvest
        assertEquals(IntervalState.NONE, open.interval.state)
        assertEquals(PrimaryAction.START, harvesterPrimary(open)?.action)
        val paused = sheet(stateOf(viewOf(source = null, accepting = false))).harvest
        assertEquals(CommandState.DISABLED, harvesterPrimary(paused)?.state)
    }

    @Test fun `a kingdom with no completed Harvester asks to finish building`() {
        val y = sheet(stateOf(viewOf(source = null, facilities = emptyList()))).harvest
        assertFalse(y.complete)
        assertEquals(CommandState.LOCKED, harvesterPrimary(y)?.state)
    }

    @Test fun `a refresh in flight keeps counts unknown and the primary busy`() {
        val s = sheet(stateOf(view = null, busy = true))
        assertEquals(CraftHydration.Loading, s.harvest.hydration)
        assertNull(s.harvest.stock.available)
        assertEquals(CommandState.BUSY, harvesterPrimary(s.harvest)?.state)
    }

    @Test fun `a sent request with no answer is being checked, a definitive refusal is REFUSED`() {
        val lost = HarvesterOperation(command, 2, null, null)
        assertEquals(SubmitStage.CHECKING, harvesterSubmit(lost, confirming = false).stage)
        val refused = HarvesterOperation(command, 2, null, HarvesterRefusal(409, "HARVESTER_POLICY_CHANGED"))
        assertEquals(SubmitStage.REFUSED, harvesterSubmit(refused, confirming = false).stage)
    }

    @Test fun `a SOL-priced upgrade step is never priced here and waits for the money lane`() {
        val price = harvesterUpgradeCost(harvesterBuilding.copy(paidStep = true))!!
        assertEquals(Currency.SOL, price.currency)
        assertEquals(PriceStatus.UNAVAILABLE, price.status)
        assertNull(price.amount)
        assertEquals(MONEY_WIRING_PENDING, price.description)
        assertEquals(PriceStatus.SHORT, harvesterUpgradeCost(harvesterBuilding.copy(shardsBalance = "100"))?.status)
        assertNull("max level hides UPGRADE", harvesterUpgradeCost(harvesterBuilding.copy(level = 5)))
    }

    @Test fun `HISTORY lists server hauls newest first with the delivered amount`() {
        val s = sheet(stateOf(operation = accepted(twoHauls)), tab = HarvesterTab.HISTORY)
        assertEquals(HarvesterTab.HISTORY, s.frame.selectedTab)
        val records = s.history!!.records
        assertEquals(listOf("$sourceId:2", "$sourceId:1"), records.map { it.id })
        assertEquals("+11", records.first().amount)
    }

    @Test fun `COLLECT and the celebration only mark seen, CHECK only checks the receipt`() {
        val calls = mutableListOf<String>()
        val on = harvesterLiveActions({}, {}, { calls += "start" }, { calls += "seen" }, {}, {}, {}, { calls += "refresh" }, {},
            { calls += "check" }, {}, { calls += "confirm" })
        on.onCollectSeen(); on.onCelebrationDone("job"); on.onCheckSaved("op"); on.onCheckObservations()
        assertEquals(listOf("seen", "seen", "check", "refresh"), calls)
    }
}
