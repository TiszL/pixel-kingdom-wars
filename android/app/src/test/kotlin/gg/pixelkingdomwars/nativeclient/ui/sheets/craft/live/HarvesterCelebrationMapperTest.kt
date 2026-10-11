package gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live

import gg.pixelkingdomwars.nativeclient.harvester.HarvesterCommand
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterEvent
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterFacility
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterOperation
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterPolicy
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterProof
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterRefusal
import gg.pixelkingdomwars.nativeclient.harvester.HarvesterRequest
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.KeepEquipmentMarketCatalogue
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterArrivedUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterIntervalUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterPolicyUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterYieldUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.IntervalState
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.StockUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.harvesterPolicyLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The in-place Harvester sheet's YIELD additions: the COLLECT celebration (client-only, SPEC 0.2 / §4.2), the Market sell
 * door, the REVIEW SAVED REQUEST rule and the policy line. Each case names the player-facing promise it protects: never
 * celebrate nothing, never show a door that leads nowhere, never resume a request that is already settled, never claim
 * more yield than the server states. Authored without a build; the main loop runs it.
 */
class HarvesterCelebrationMapperTest {
    private val wallet = "DaEy4YZ9xwiGzw1nTQVB1vxCTZRBQJhbmLU55BXQ2jgi"
    private val base = "12345678-1234-4678-9abc-def012345601"
    private val harvesterId = "12345678-1234-4678-9abc-def012345602"
    private val sourceId = "12345678-1234-4678-9abc-def012345603"
    private val policy = HarvesterPolicy(1, 1, "48", "12", 21_600, 86_400, 1, 10_000, 500)
    private val facility = HarvesterFacility(base, harvesterId, "12345678-1234-4678-9abc-def012345604", "2029-12-31T00:00:00.000Z")
    private val command = HarvesterCommand(HarvesterRequest(sourceId, base, harvesterId, null, 1), facility, "crownlands", policy, null)
    private fun event(ordinal: Int, sequence: String, earnedAt: String, net: String = "11", gross: String = "12") =
        HarvesterEvent(sourceId, ordinal, sequence, "crown_iron_ore", 1, earnedAt, earnedAt.replace(":00.000Z", ":05.000Z"),
            earnedAt.substring(0, 10) + "T00:00:00.000Z", gross, net, "1", 1, 10_000, 500, "0", "0")
    /** harvester-yield.png's state (placeholder numbers): Crown Iron Ore, up to 12 every 6h, nothing unseen. */
    private val gathering = HarvesterYieldUi(realmId = "crownlands", artKey = "crownlands", resourceId = "crown_iron_ore", level = 2,
        tier = 2, policy = HarvesterPolicyUi(12, 21_600), interval = HarvesterIntervalUi(IntervalState.RUNNING, null, null),
        arrived = HarvesterArrivedUi(0, null), todayArrived = 36, stock = StockUi(48), nextLevelDelta = "+4 per haul at Lv 3",
        upgradeCost = null, actionsAllowed = true, saved = null, realmName = "Crownlands", resourceName = "Crown Iron Ore")
    /** harvester-arrived.png's state: 12 delivered and not yet acknowledged. */
    private val arrived = gathering.copy(arrived = HarvesterArrivedUi(12, "2030-01-01T12:00:05.000Z"))

    @Test fun `an unseen haul names what reached the stores on the ribbon`() {
        val party = harvesterArrivedCelebration(arrived, "$sourceId:5")!!
        assertEquals("HAUL ARRIVED", party.title)
        assertEquals("the ribbon is the delivered quantity and the server's resource", "+12 CROWN IRON ORE", party.ribbon)
        assertEquals(arrived.resourceIcon, party.icon)
        assertEquals("$sourceId:5", party.jobId)
        assertTrue("COLLECT never implies a new delivery: the haul is already stored", party.line.lowercase().contains("already safe in your stores"))
    }

    @Test fun `nothing unseen means no celebration so COLLECT never celebrates nothing`() {
        assertNull(harvesterArrivedCelebration(gathering, "$sourceId:4"))
        assertNull(harvesterArrivedCelebration(arrived.copy(arrived = arrived.arrived.copy(unseenQuantity = 0L)), "$sourceId:4"))
    }

    @Test fun `the celebration is read before the marker moves because afterwards the same haul reads as seen`() {
        val events = listOf(event(1, "4", "2030-01-01T06:00:00.000Z"), event(2, "5", "2030-01-01T12:00:00.000Z"))
        val shown = arrived.copy(arrived = harvesterArrived(events, seenThrough = "4"))
        assertEquals("+11 CROWN IRON ORE", harvesterArrivedCelebration(shown, "$sourceId:5")?.ribbon)
        val acknowledged = arrived.copy(arrived = harvesterArrived(events, seenThrough = "5"))
        assertNull("once the marker is at the newest sequence nothing is left to name", harvesterArrivedCelebration(acknowledged, "$sourceId:5"))
    }

    @Test fun `large deliveries are grouped and an unknown resource name never prints the ellipsis`() {
        val big = arrived.copy(arrived = arrived.arrived.copy(unseenQuantity = 1_234_567L))
        assertEquals("+1,234,567 CROWN IRON ORE", harvesterArrivedCelebration(big, "k")?.ribbon)
        val unnamed = arrived.copy(resourceName = UNKNOWN, arrivedNoun = "units")
        assertEquals("+12 UNITS", harvesterArrivedCelebration(unnamed, "k")?.ribbon)
    }

    @Test fun `the sell door appears only for a resource the KEEP Market lists`() {
        val door = harvesterSellDoor("crown_iron_ore", setOf("crown_iron_ore"))!!
        assertEquals("GO hands back the item to sell", "crown_iron_ore", door.id)
        assertEquals("Spare ore", door.title); assertEquals("Sell it at the Market", door.line)
        // Raw ores are not KEEP Market items in today's catalogue, so the live sheet shows no dead Sell door.
        assertNull(harvesterSellDoor("crown_iron_ore", KeepEquipmentMarketCatalogue.itemIds))
        assertNull(harvesterSellDoor(null, setOf("crown_iron_ore")))
    }

    @Test fun `only an unproven unrefused request of this kingdom offers REVIEW SAVED REQUEST`() {
        assertTrue("a saved draft resumes by re-review", harvesterSavedReviewable(HarvesterOperation(command, null, null, null), base))
        assertTrue("a sent request with no answer re-reviews the same key", harvesterSavedReviewable(HarvesterOperation(command, 2, null, null), base))
        assertFalse("a declined request is checked and archived, never resent",
            harvesterSavedReviewable(HarvesterOperation(command, 2, null, HarvesterRefusal(409, "HARVESTER_POLICY_CHANGED")), base))
        assertFalse("an accepted request is settled",
            harvesterSavedReviewable(HarvesterOperation(command, 2, HarvesterProof(wallet, command.key, "2030-01-01T08:00:00.000Z", "accepted", null, null), null), base))
        assertFalse("another kingdom's request is not this sheet's", harvesterSavedReviewable(HarvesterOperation(command, 2, null, null),
            "12345678-1234-4678-9abc-def012345609"))
        assertFalse(harvesterSavedReviewable(null, base))
        assertFalse(harvesterSavedReviewable(HarvesterOperation(command, 2, null, null), null))
    }

    @Test fun `REVIEW SAVED REQUEST and the celebration dismissal reach their own callbacks`() {
        val calls = mutableListOf<String>()
        val on = harvesterLiveActions({}, {}, { calls += "start" }, { calls += "seen" }, {}, {}, {}, {}, {}, {}, {}, {},
            reviewSaved = { calls += "saved" }, celebrationDone = { calls += "done" })
        on.onReviewSaved(); on.onCelebrationDone("job"); on.onCollectSeen()
        // The dismissal only clears the party: the marker already moved on the COLLECT tap.
        assertEquals(listOf("saved", "done", "seen"), calls)
        val legacy = harvesterLiveActions({}, {}, { calls += "start" }, { calls += "seen" }, {}, {}, {}, {}, {}, {}, {}, {})
        calls.clear(); legacy.onReviewSaved(); legacy.onCelebrationDone("job")
        assertEquals("a host without its own wiring keeps today's behaviour", listOf("start", "seen"), calls)
    }

    @Test fun `the policy line claims a higher level gathers more only when the server gives the next level gain`() {
        assertEquals("Up to 12 every 6h. A higher level gathers more.", harvesterPolicyLine(gathering))
        assertEquals("Up to 12 every 6h.", harvesterPolicyLine(gathering.copy(nextLevelDelta = null)))
    }
}
