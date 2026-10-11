package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.EquipmentView
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/** Authored before the owner presentation change; execution belongs to Cedar3. */
class EquipmentWorkshopMapperTest {
    private val f = EquipmentFixtures
    private val identity = f.identity()
    private fun ready() = EquipmentState(view = EquipmentView.from(f.readyView()),
        journal = EquipmentJournal(identity = identity))
    private fun map(state: EquipmentState = ready(), current: Boolean = true, readCurrent: Boolean = true,
        allowed: Boolean = true, running: Boolean = false, noticeError: Boolean = false) =
        equipmentWorkshopSheetUi(state, identity, f.base, current, readCurrent, allowed,
            running = running, notice = if (noticeError) "The latest read failed." else null, noticeError = noticeError,
            serverOffsetMs = 0L)

    @Test fun `current stock and recipe render the designed tool with one exact output`() {
        val ui = map()
        val tools = requireNotNull(ui.tools)
        assertNull(ui.observation)
        assertEquals(WorkshopTab.EQUIPMENT, ui.frame.selectedTab)
        assertEquals(setOf(WorkshopTab.REFINE, WorkshopTab.INGOTS, WorkshopTab.EQUIPMENT, WorkshopTab.COSMETICS), ui.frame.tabs.map { it.id }.toSet())
        assertEquals("craft_route_compass", tools.recipes.single().recipeId)
        assertEquals("Route Compass", tools.recipes.single().name)
        assertEquals(f.recipe.durationSec, tools.recipes.single().durationSec)
        assertEquals(f.recipe.inputs.map { it.quantity.toLong() }, tools.recipes.single().inputs.map { it.perUnit })
        assertEquals(1L, tools.owned.getValue("route_compass"))
        assertEquals(PrimaryAction.START, toolsPrimary(tools, 0L)!!.action)
        assertNull(ui.review)
        assertNull(ui.celebration)
        assertFalse(ui.destinationsAvailable)
    }
    @Test fun `foreign wallet base or journal never supplies current stock`() {
        val source = ready()
        val variants = listOf(source.copy(view = source.view!!.copy(wallet = "11111111111111111111111111111111")),
            source.copy(view = source.view!!.copy(baseId = "00000000-0000-4000-8000-000000000099")),
            source.copy(journal = EquipmentJournal(identity = identity.copy(origin = "https://other.invalid"))))
        variants.forEach { state -> assertNull(map(state).tools); assertNotNull(map(state).observation) }
    }
    @Test fun `a retained value without a completed current read stays unavailable`() {
        assertNull(map(current = false).tools)
        assertNull(map(readCurrent = false).tools)
        assertFalse(map(current = false).observation!!.canRetry)
        assertTrue(map(readCurrent = false).observation!!.loading)
    }
    @Test fun `missing view does not claim an empty workshop`() {
        val ui = map(ready().copy(view = null))
        assertNull(ui.tools)
        assertNotNull(ui.observation)
        assertTrue(ui.observation!!.canRetry)
        assertFalse(ui.observation!!.message.contains("Empty bench"))
    }
    @Test fun `read failure outranks retained stock and leaves recovery available`() {
        for (state in listOf(ready().copy(error = "Failed read"), ready().copy(view = null, error = "Failed read"))) {
            val ui = map(state)
            assertNull(ui.tools)
            assertTrue(ui.observation!!.message.contains("Failed read"))
            assertTrue(ui.observation!!.canRetry)
            assertTrue(ui.frame.history)
        }
        assertNull(map(noticeError = true).tools)
    }
    @Test fun `busy view model and repository cannot expose craft`() {
        assertNull(map(running = true).tools)
        assertNull(map(ready().copy(busy = true)).tools)
        assertFalse(map(running = true).observation!!.canRetry)
    }
    @Test fun `paused orders keep stock readable and close craft`() {
        val tools = map(allowed = false).tools!!
        assertEquals(1L, tools.owned.getValue("route_compass"))
        assertFalse(tools.actionsAllowed)
        assertNotEquals(PrimaryAction.START, toolsPrimary(tools, 0L)!!.action)
        assertFalse(map(ready().copy(view = ready().view!!.copy(acceptingJobs = false))).tools!!.acceptingJobs)
    }
    @Test fun `missing ingredients remain exact and close craft`() {
        val state = ready()
        val view = state.view!!.copy(craftingStock = state.view!!.craftingStock.map { it.copy(available = "0") })
        val tools = map(state.copy(view = view)).tools!!
        assertTrue(toolLines(tools).any { it.short })
        assertNotEquals(PrimaryAction.START, toolsPrimary(tools, 0L)!!.action)
    }
    @Test fun `unresolved original shows its own key and blocks another craft`() {
        val record = f.record()
        val state = ready().copy(journal = EquipmentJournal(identity = identity, pending = listOf(record)))
        val tools = map(state).tools!!
        assertEquals(record.key, tools.saved!!.opId)
        assertNotEquals(PrimaryAction.START, toolsPrimary(tools, 0L)!!.action)
        assertNull(map(state).review)
    }
    @Test fun `review never becomes a second synthesized review or submit`() {
        val tools = map(ready().copy(review = f.record())).tools!!
        assertFalse(tools.actionsAllowed)
        assertNull(map(ready().copy(review = f.record())).review)
    }
    @Test fun `recovery points to the unresolved original when an earlier saved record is complete`() {
        val finished = f.record().let { it.copy(response = f.complete(it)) }
        val pending = f.record(key = "00000000-0000-4000-8000-000000000077")
        val state = ready().copy(journal = EquipmentJournal(identity = identity, pending = listOf(finished, pending)))
        assertEquals(pending.key, map(state).tools!!.saved!!.opId)
    }
    @Test fun `reserved stock is owned but return times stay unknown without complete trip coverage`() {
        // Rewritten for the designed TravelRow (craft/SPEC.md §2.6): the reserved count now rides the trips door that
        // replaces the old TRIPS button instead of a plain text line. The rule is unchanged: a count, never a return time.
        val state = ready()
        val view = state.view!!.copy(equipmentStock = state.view!!.equipmentStock.map { it.copy(available = "2", reserved = "3") })
        val tools = map(state.copy(view = view)).tools!!
        assertEquals(5L, tools.owned.getValue("route_compass"))
        assertTrue(tools.travelling.isEmpty())
        val door = tools.tripsDoor!!
        assertEquals(TOOLS_TRIPS_AWAY, door.id)
        assertTrue(door.title.contains("3"))
        assertTrue(door.line.contains("Return times"))
        assertNull(tools.travellingNotice)
        assertNull(travelSummary(tools, 0L))
    }
    @Test fun `zero reserved tools is an observed zero not a fabricated trip list`() {
        val tools = map().tools!!
        assertTrue(tools.travelling.isEmpty())
        assertNull(tools.travellingNotice)
    }
    @Test fun `with nothing reserved the trips door carries the purpose line and never claims a tool is away`() {
        // The old TRIPS button had to keep a door; with no tool away it must not look like the away TravelRow.
        val door = map().tools!!.tripsDoor!!
        assertEquals(TOOLS_TRIPS_FIT, door.id)
        assertEquals("Fit it on Lodge trips", door.title)
        assertFalse(door.title.contains("reserved"))
        assertEquals("ui:lodge-menu", door.icon)
    }
    @Test fun `one reserved tool reads in the singular`() {
        assertEquals("1 tool is reserved for trips.", equipmentTripsDoor(1L).title)
        assertEquals("2 tools are reserved for trips.", equipmentTripsDoor(2L).title)
        assertEquals(TOOLS_TRIPS_FIT, equipmentTripsDoor(0L).id)
    }
    @Test fun `the tool cards carry the designed effect lines`() {
        // craft/SPEC.md §2.6 and workshop-tools.png: the Compass line names its cost honestly ("a bit less cargo").
        assertEquals("Faster return, a bit less cargo.", map().tools!!.recipes.single().effect)
    }
    @Test fun `the record under the in sheet review is not also a waiting earlier request`() {
        // While the half sheet shows a draft, that draft is the review itself; a second "request from earlier" row for
        // the same record would send the player to CHECK what they are reviewing. After BACK it is the recovery row again.
        val record = f.record()
        val pending = ready().copy(journal = EquipmentJournal(identity = identity, pending = listOf(record)))
        assertNull(map(pending.copy(review = record)).tools!!.saved)
        assertEquals(record.key, map(pending).tools!!.saved!!.opId)
    }
    @Test fun `another unresolved record still shows while a different draft is reviewed`() {
        val other = f.record(key = "00000000-0000-4000-8000-000000000077")
        val reviewed = f.record()
        val state = ready().copy(journal = EquipmentJournal(identity = identity, pending = listOf(reviewed, other)), review = reviewed)
        assertEquals(other.key, map(state).tools!!.saved!!.opId)
    }
    @Test fun `a running read keeps the last current tools drawn with unknown counts and a busy primary`() {
        // craft/SPEC.md §5: a refresh never blanks what was shown; counts become unknown and nothing can be started.
        val last = map().tools!!
        val retained = equipmentRetainedSheetUi(map(running = true), last, reading = true)
        assertNull(retained.observation)
        val tools = retained.tools!!
        assertEquals(CraftHydration.Loading, tools.hydration)
        assertFalse(tools.actionsAllowed)
        assertTrue(toolLines(tools).all { it.have == null })
        assertEquals(PrimaryAction.NONE, toolsPrimary(tools, 0L)!!.action)
    }
    @Test fun `failed foreign or idle unread states keep their own reason and retry door`() {
        val last = map().tools!!
        val failed = map(ready().copy(error = "Failed read"))
        assertSame(failed, equipmentRetainedSheetUi(failed, last, reading = true))
        val foreign = map(current = false)
        assertSame(foreign, equipmentRetainedSheetUi(foreign, last, reading = true))
        // Nothing is reading, so a retained snapshot would show busy dots forever with no TRY AGAIN.
        val idle = map(readCurrent = false)
        assertSame(idle, equipmentRetainedSheetUi(idle, last, reading = false))
        assertTrue(idle.observation!!.canRetry)
    }
    @Test fun `no earlier snapshot leaves the honest checking state`() {
        val fresh = map(running = true)
        assertSame(fresh, equipmentRetainedSheetUi(fresh, null, reading = true))
    }
    @Test fun `pending tool job uses server times and never becomes completed from clock`() {
        val state = ready().copy(view = f.view)
        val tools = map(state).tools!!
        assertEquals(f.view.pendingJobs.single().jobId, tools.job!!.jobId)
        assertNotEquals(PrimaryAction.START, toolsPrimary(tools, Long.MAX_VALUE / 2)!!.action)
        assertNull(map(state).celebration)
    }
    @Test fun `timed job without server clock admission remains unavailable`() {
        val ui = equipmentWorkshopSheetUi(ready().copy(view = f.view), identity, f.base,
            current = true, readCurrent = true, actionsAllowed = true, serverOffsetMs = null)
        assertNull(ui.tools)
        assertNotNull(ui.observation)
    }
    @Test fun `unsupported multiple bench jobs do not silently discard a job`() {
        val view = f.view
        val first = view.pendingJobs.single()
        val duplicate = first.copy(jobId = "00000000-0000-4000-8000-000000000099")
        val jobs = view.copy(pendingJobs = listOf(first, duplicate), equipmentStock = view.equipmentStock.map { it.copy(pendingOutput = "2") })
        assertNull(map(ready().copy(view = jobs)).tools)
    }
    @Test fun `unsupported numeric values fail closed before narrowing`() {
        val state = ready()
        val view = state.view!!.copy(equipmentStock = state.view!!.equipmentStock.map { it.copy(available = "9223372036854775808") })
        assertNull(map(state.copy(view = view)).tools)
    }
    @Test fun `selected recipe always follows the current owner item`() {
        val state = ready().copy(item = "survey_lens")
        assertNull(map(state).tools)
    }
    @Test fun `original expedition confirmation history and saved terms remain byte identical`() {
        val source = source("ui/phasee/EquipmentScreen.kt")
        val original = source.substring(source.indexOf("@Composable private fun EquipmentExpeditions"))
        // Rewritten 2026-10-06 (dead-end audit): EquipmentHistory deliberately gained the closed-record note, the closed-record
        // retry guard and the CHECK & CLOSE IF NOT FOUND door (owner rule: a request the server does not know never blocks play
        // forever). Expeditions, confirmation and saved terms are unchanged; the pinned bytes follow the new history door.
        assertEquals("887aaf13d94af8444a0cfa7ab95abe910e9ba8813346d01678feebb68c52d960", sha(original))
        assertFalse(source.contains("private fun EquipmentWorkshop("))
        assertTrue(source.contains("WorkshopSheet("))
        assertTrue(source.contains("EquipmentConfirmation(review, selectedBase"))
        assertTrue(source.contains("EquipmentHistory(state, selectedBase"))
        assertTrue(source.contains("EquipmentExpeditions(state, selectedBase"))
    }
    @Test fun `registration retains one owner lifecycle and supplies presentation identity`() {
        val source = source("ui/phasee/EquipmentRegistration.kt")
        assertEquals(1, Regex("EquipmentViewModel\\(it\\)").findAll(source).count())
        assertTrue(source.contains("model?.foreground()"))
        assertTrue(source.contains("equipmentPresentationCurrent"))
        val screen = source("ui/phasee/EquipmentScreen.kt")
        assertFalse(screen.contains("model.foreground("))
        assertFalse(screen.contains("EquipmentViewModel("))
        assertTrue(screen.contains("lifecycle.currentStateFlow.collectAsState()"))
        assertTrue(screen.contains("openingView"))
        assertTrue(screen.contains("LocalWorkshopOwnerHost.current"))
    }
    @Test fun `tools ingredient destinations are hidden until bound`() {
        val body = source("ui/sheets/craft/WorkshopToolsTab.kt")
        assertTrue(body.contains("showGo = destinationsAvailable"))
        assertTrue(source("ui/sheets/craft/WorkshopSheet.kt").contains("WorkshopToolsBody(it, on, now, destinationsAvailable = ui.destinationsAvailable)"))
    }
    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }
    private fun sha(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
        .joinToString("") { "%02x".format(it) }
}
