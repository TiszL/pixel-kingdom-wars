package gg.pixelkingdomwars.nativeclient.ui

import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import gg.pixelkingdomwars.nativeclient.model.ArmyStatus
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.renderer.BaseCameraView
import gg.pixelkingdomwars.nativeclient.renderer.BuildingCarryInput
import gg.pixelkingdomwars.nativeclient.renderer.CarryEvent
import gg.pixelkingdomwars.nativeclient.renderer.CarryMode
import gg.pixelkingdomwars.nativeclient.renderer.CarryRect
import gg.pixelkingdomwars.nativeclient.renderer.RenderBuilding
import gg.pixelkingdomwars.nativeclient.scene.firstPaintedRow
import gg.pixelkingdomwars.nativeclient.scene.roofWorldY
import gg.pixelkingdomwars.nativeclient.ui.kingdom.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert
import org.junit.Test

/** Owner 2026-09-19: the army readout was one black block floating over the map, bigger than the building it
 * described. These pin the replacement: a small chip ON the camp / barracks, from server numbers only. */
class ArmyChipsTest {
    @Test fun `only a chip visible at pointer down can claim the later renderer confirmed tap`() {
        val hits = ArmyChipHits(); val claim = ArmyChipTapClaim()
        val visible = BaseCameraView("base", 320f, 320f, 1f, 640, 640)
        hits.place("rax", 280, 275, 80, 30)
        claim.down(hits.atScreen(visible, 320f, 288f))
        assertNull(hits.atScreen(visible.copy(overlayVisible = false), 320f, 288f), "hidden chips are never hit targets")
        assertNull(hits.buildingAt(visible.copy(overlayVisible = false), 5f, 4.5f, 64f))
        assertEquals("rax", claim.takeDownChip(), "a genuine tap retains the chip the player saw when pressing")
        assertNull(claim.takeDownChip(), "a captured target is consumed once")
        claim.down("rax") // A pan/cancel has no renderer tap callback.
        claim.down(null)
        assertNull(claim.takeDownChip(), "the next gesture cannot inherit the prior pan's target")
    }
    // The app module tests on plain JUnit; these keep the reason beside the value it explains.
    private fun <T> assertEquals(expected: T, actual: T, why: String? = null) = Assert.assertEquals(why, expected, actual)
    private fun assertEquals(expected: Float, actual: Float, delta: Float, why: String? = null) = Assert.assertEquals(why, expected, actual, delta)
    private fun assertTrue(value: Boolean, why: String? = null) = Assert.assertTrue(why, value)
    private fun assertFalse(value: Boolean) = Assert.assertFalse(value)
    private fun assertNull(value: Any?, why: String? = null) = Assert.assertNull(why, value)
    private fun <T : Any> assertNotNull(value: T?): T { Assert.assertNotNull(value); return value!! }
    private val now = 1_800_000_000_000L
    private fun at(seconds: Long) = java.time.Instant.ofEpochMilli(now + seconds * 1000).toString()
    private fun base(buildings: String, army: String? = """{"readyTroopCount":10,"readyPts":42,"campCapacityPts":108,"trainingTroopCount":0,"trainingPts":0,"barracksQueuePts":65}""", jobs: String = "[]") =
        BaseSnapshot.from(Json.parseToJsonElement("""{"baseId":"base-1","player":{"keepLevel":5},${army?.let { "\"armyStatus\":$it," } ?: ""}"buildings":$buildings,"jobs":$jobs}""").jsonObject)
    private fun building(id: String, type: String, level: Int = 1, building: Boolean = false) = """{"id":"$id","type":"$type","level":$level,"tx":10,"ty":10,"underConstruction":$building}"""
    private val home = ArmyChipScene(home = true)
    private val camps = "[${building("camp-b", "camp", 2)},${building("camp-a", "camp", 2)},${building("camp-c", "camp", 1)},${building("camp-z", "camp", 9, building = true)},${building("rax", "barracks")}]"

    @Test fun `one camp carries the base-wide housing chip, by a rule a move or a refresh cannot change`() {
        // Housing is one pool: the same number on every camp litters the map. Highest level, then lowest id; a camp
        // still under construction holds nothing, whatever its level.
        assertEquals(listOf("camp-a"), armyChips(base(camps), now, home).map { it.buildingId })
        assertEquals("camp-a", armyChipCarrier(base(camps).buildings.reversed(), "camp")?.id, "row order from the server must not move the chip")
        assertNull(armyChipCarrier(base("[${building("camp-z", "camp", 9, building = true)}]").buildings, "camp"))
    }

    @Test fun `the camp chip reads server housing - empty, partial, FULL and OVER - and never a client cap`() {
        fun chip(ready: Int, training: Int?, capacity: Int) = campChip("camp", ArmyStatus(readyPts = ready, trainingPts = training, campCapacityPts = capacity))
        assertEquals(ArmyChipTone.NORMAL to listOf(listOf("0/108")), chip(0, 0, 108).let { it.tone to it.labels })
        assertEquals(listOf(listOf("42/108")), chip(30, 12, 108).labels, "queued troops already reserve their housing")
        assertEquals(listOf(listOf("42/108")), chip(42, null, 108).labels, "an older server omits trainingPts")
        chip(100, 8, 108).let { assertEquals(ArmyChipTone.FULL, it.tone); assertEquals(listOf(listOf("FULL 108/108"), listOf("FULL")), it.labels) }
        chip(108, 4, 108).let { assertEquals(ArmyChipTone.OVER, it.tone); assertEquals(listOf(listOf("OVER 112/108"), listOf("OVER")), it.labels) }
        assertEquals(ArmyChipTone.NORMAL, chip(0, 0, 0).tone, "no housing yet is not FULL")
    }

    @Test fun `an idle barracks shows nothing and a training one counts down with the shared duration words`() {
        val idle = base("[${building("rax", "barracks")}]")
        assertTrue(armyChips(idle, now, home).isEmpty())
        fun training(allReadyAt: String?, queue: String = ""","trainingPts":18,"barracksQueuePts":65""") = base("[${building("rax", "barracks")},${building("rax-2", "barracks")}]",
            """{"readyPts":0,"campCapacityPts":108,"trainingTroopCount":3,"allReadyAt":${allReadyAt?.let { "\"$it\"" }}$queue}""")
        val chip = armyChips(training(at(252)), now, home).single()
        assertEquals("rax", chip.buildingId, "the queue is base-wide too: one barracks carries it")
        assertEquals(ArmyChipTone.TRAINING, chip.tone)
        assertEquals(listOf(listOf("3 TRAINING · 4m 12s · 18/65"), listOf("3 TRAINING · 4m 12s"), listOf("3 TRAINING", "4m 12s"), listOf("3", "4m 12s")), chip.labels)
        // D-070: days above 24 h, and never the battle clock's m:ss.
        assertEquals(listOf("3 TRAINING", "1d 2h"), armyChips(training(at(93_600)), now, home).single().labels[2])
        assertEquals(listOf(listOf("3 TRAINING · 59s"), listOf("3 TRAINING", "59s"), listOf("3", "59s")), armyChips(training(at(59), queue = ""), now, home).single().labels)
        // Only the next server read may declare troops ready; never keep a stopped timer or invent completion.
        for (late in listOf(at(-5), "soon", null)) assertEquals(listOf(listOf("3 TRAINING · VERIFYING · 18/65"), listOf("3 TRAINING · VERIFYING"), listOf("3 TRAINING", "VERIFYING"), listOf("3", "VERIFYING")), armyChips(training(late), now, home).single().labels)
    }

    @Test fun `a chip tap wins over a neighbours footprint and does not swallow the next ordinary tap`() {
        val hits = ArmyChipHits(); val claim = ArmyChipTapClaim()
        val camera = BaseCameraView("base-1", 320f, 320f, 1f, 640, 640)
        hits.place("rax", 280, 275, 80, 30)
        var selected: String? = null
        val chip = hits.buildingAt(camera, 5f, 4.5f, 64f)
        claim.ground(chip); chip?.let { selected = it }
        // The renderer posts the ground hit first, then the building footprint lying underneath the chip.
        if (claim.allowFootprint()) selected = "north-neighbour"
        assertEquals("rax", selected, "tapping TRAINING must open TRAIN TROOPS, not the neighbouring building")
        claim.ground(null); if (claim.allowFootprint()) selected = "north-neighbour"
        assertEquals("north-neighbour", selected)
        claim.ground("rax") // A chip over bare ground has no footprint callback; the next tap still resets it.
        claim.ground(null); assertTrue(claim.allowFootprint())
    }

    @Test fun `world chip origin stays at the physical left in right to left layouts`() {
        // Anchored nodes measure zero-sized. TopStart would move the origin a whole screen width on Arabic devices.
        for (direction in listOf(LayoutDirection.Ltr, LayoutDirection.Rtl))
            assertEquals(IntOffset.Zero, ArmyChipAlignment.align(IntSize.Zero, IntSize(1080, 2400), direction))
    }

    @Test fun `each training deadline wakes Home before the catalogue poll or a later building completion`() {
        fun snapshot(next: String?, all: String?, count: Int = 3, jobs: String = "[]") = base(camps,
            """{"trainingTroopCount":$count,"nextReadyAt":${next?.let { "\"$it\"" }},"allReadyAt":${all?.let { "\"$it\"" }}}""", jobs)
        assertEquals(now + 2000, homeRefreshDeadline(snapshot(at(2), at(60))))
        assertEquals(now + 60000, homeRefreshDeadline(snapshot("bad", at(60))), "allReadyAt is the fallback for older snapshots")
        assertEquals(now - 1000, homeRefreshDeadline(snapshot(at(-1), at(60))), "an elapsed deadline must promptly request authoritative state")
        assertNull(homeRefreshDeadline(snapshot(null, null)))
        assertNull(homeRefreshDeadline(snapshot(at(2), at(60), count = 0)), "an empty queue does not poll stale training dates")
        val job = """[{"id":"job","kind":"build","finishesAt":"${at(1)}"}]"""
        assertEquals(now + 1000, homeRefreshDeadline(snapshot(at(2), at(60), jobs = job)), "earlier building jobs retain priority")
    }

    @Test fun `chips yield to every mode that owns the map and to their own sheet`() {
        val training = base(camps, """{"readyPts":42,"campCapacityPts":108,"trainingTroopCount":2,"trainingPts":6,"barracksQueuePts":65,"allReadyAt":"${at(90)}"}""")
        assertEquals(listOf("camp-a", "rax"), armyChips(training, now, home).map { it.buildingId })
        for (mode in listOf(home.copy(home = false), home.copy(editing = true), home.copy(placing = true), home.copy(carrying = true)))
            assertTrue(armyChips(training, now, mode).isEmpty(), "$mode")
        assertEquals(listOf("rax"), armyChips(training, now, home.copy(sheetBuildingId = "camp-a")).map { it.buildingId }, "the open sheet already says it; the chip must not hop to another camp")
        assertEquals(listOf("camp-a"), armyChips(training, now, home.copy(movingIds = setOf("rax"))).map { it.buildingId }, "a dropped building waits for the server on its new tile")
        assertTrue(armyChips(base("[${building("keep", "keep")}]"), now, home).isEmpty(), "no camp and no barracks")
        assertTrue(armyChips(base(camps, army = null), now, home).isEmpty(), "no armyStatus from the server, no numbers")
        assertTrue(armyChips(null, now, home).isEmpty())
    }

    @Test fun `chips come back after every way a hold-to-lift can end, including a slow tap that never moved`() {
        // A landed player who presses a building for 200 ms and lifts without dragging armed a carry and then tapped:
        // the sheet opens, and once it closes the chips must be there again. They used to stay hidden until a later carry.
        val training = base(camps, """{"readyPts":42,"campCapacityPts":108,"trainingTroopCount":2,"trainingPts":6,"barracksQueuePts":65,"allReadyAt":"${at(90)}"}""")
        var carrying = false; var hiddenWhileLifted = false
        val input = BuildingCarryInput({ carrying = carryOwnsMap(carrying, it); if (it is CarryEvent.Armed) hiddenWhileLifted = armyChips(training, now, home.copy(carrying = carrying)).isEmpty() }) { 12f }
        val mode = CarryMode("base-1", setOf("camp-a", "rax"), emptySet(), 0, 40, listOf(CarryRect("camp-a", 10, 10, 2, 2), CarryRect("rax", 20, 10, 2, 2)))
        fun visible() = armyChips(training, now, home.copy(carrying = carrying)).map { it.buildingId }
        input.frame(mode, "base-1", battle = false)
        // 1. The slow tap: down, the hold elapses, up with no movement.
        input.down(0, "camp-a", 100f, 100f, 1000); input.tick(1300)
        assertTrue(hiddenWhileLifted, "a lifted building owns the map")
        assertFalse(input.up(0, 1400)); assertEquals(listOf("camp-a", "rax"), visible(), "the slow tap")
        // 2. A real carry put down, 3. a carry a second finger cancelled, 4. a platform reset mid-hold.
        input.down(0, "camp-a", 100f, 100f, 2000); input.tick(2300); input.move(0, 160f, 100f, 14f, 11f, 2350); assertTrue(visible().isEmpty())
        assertTrue(input.up(0, 2400)); assertEquals(listOf("camp-a", "rax"), visible(), "released")
        input.down(0, "rax", 100f, 100f, 3000); input.tick(3300); input.down(1, null, 200f, 200f, 3350)
        assertEquals(listOf("camp-a", "rax"), visible(), "cancelled by a pinch"); input.up(1, 3400); input.up(0, 3450)
        input.down(0, "rax", 100f, 100f, 4000); input.tick(4300); input.reset(); assertEquals(listOf("camp-a", "rax"), visible(), "paused mid-hold")
    }

    @Test fun `a chip waits for the drawn scene to catch up with a moved building`() {
        val moved = base("[${building("camp-a", "camp")},${building("rax", "barracks")}]")
        val drawn = listOf(RenderBuilding("camp-a", "bld_camp_l1", 10f, 10f, 2f, 2f), RenderBuilding("rax", "bld_barracks_l1", 4f, 10f, 2f, 1f))
        assertEquals(setOf("rax"), unsettledIds(moved, drawn), "the scene still draws the barracks on its old tile")
        assertEquals(setOf("camp-a", "rax"), unsettledIds(moved, emptyList()), "a building the scene has not mapped yet has no roof to sit on")
        assertEquals(emptySet<String>(), unsettledIds(null, drawn))
    }

    @Test fun `a chip stacks above a job chip on the same building instead of covering it`() {
        val upgrading = base(camps, jobs = """[{"id":"job-1","kind":"upgrade","buildingId":"camp-a"}]""")
        assertTrue(armyChips(upgrading, now, home).single().aboveJob)
        assertFalse(armyChips(base(camps), now, home).single().aboveJob)
        val view = BaseCameraView("base-1", 640f, 640f, 1f, 1080, 2400); val anchor = ArmyChipAnchor(640f, 600f, 128f)
        val free = assertNotNull(armyChipOffset(view, anchor, 100, 40, 64f, 5f, 0f)); val stacked = assertNotNull(armyChipOffset(view, anchor, 100, 40, 64f, 5f, 30f))
        assertEquals(free.first, stacked.first); assertEquals(free.second - 30, stacked.second, "the job chip keeps the roof")
    }

    @Test fun `a chip sits centred above the painted roof and follows the drawn camera`() {
        val anchor = ArmyChipAnchor(centerX = 704f, roofY = 580f, footprintWidth = 128f)
        val view = BaseCameraView("base-1", 640f, 640f, 2f, 1080, 2400)
        val (x, y) = assertNotNull(armyChipOffset(view, anchor, 100, 40, 64f, 5f, 0f))
        assertEquals((540 + (704 - 640) / 2f - 50).toInt(), x)
        assertEquals((1200 + (580 - 640) / 2f - 5 - 40).toInt(), y, "bottom edge = roof minus the gap: never over the sprite")
        val panned = assertNotNull(armyChipOffset(view.copy(cameraX = 740f, cameraY = 600f), anchor, 100, 40, 64f, 5f, 0f))
        assertEquals(x - 50 to y + 20, panned, "a 100×-40 world pan at zoom 2 moves the chip exactly as far as its building")
        // Close zoom: the battle's 6 world px building-bar lift grows with the world and replaces the minimum gap.
        val close = assertNotNull(armyChipOffset(view.copy(zoom = .25f), anchor, 100, 40, 64f, 5f, 0f))
        assertEquals((1200 + (580 - 640) * 4f - 24 - 40).toInt(), close.second)
        assertNull(armyChipOffset(null, anchor, 100, 40, 64f, 5f, 0f), "no base frame drawn (loading, battle, scout, preview): nothing to sit on")
    }

    @Test fun `at claim-fit zoom a chip keeps within its building and says less rather than growing`() {
        // A phone's claim-fit zoom: 17 dp tiles (0.268 dp per world px), so a 2-tile camp or barracks is 34 dp wide.
        val zoom = 17f / 64; val footprint = 2 * 17f; val budget = footprint * ArmyChipMetrics.FOOTPRINT_SHARE
        fun layout(chip: ArmyChip, zoomed: Float = zoom, fontScale: Float = 1f) = assertNotNull(armyChipLayout(chip, 128 * zoomed, zoomed, fontScale))
        fun width(layout: ArmyChipLayout, fontScale: Float = 1f) = armyChipWidthDp(layout.label, layout.scale, fontScale)
        val partial = layout(campChip("camp", ArmyStatus(readyPts = 42, campCapacityPts = 108)))
        assertEquals(listOf("42/108"), partial.label); assertTrue(width(partial) <= budget, "${width(partial)} > $budget")
        assertTrue(partial.scale >= ArmyChipMetrics.MIN_FIT - .05f, "still legible")
        val full = layout(campChip("camp", ArmyStatus(readyPts = 108, campCapacityPts = 108)))
        assertEquals(listOf("FULL"), full.label, "the word outlives the numbers: tone alone is not a message"); assertTrue(width(full) <= budget)
        val training = barracksChip("rax", ArmyStatus(trainingTroopCount = 3, trainingPts = 18, barracksQueuePts = 65, allReadyAt = at(252)), now)
        layout(training).let { assertEquals(listOf("3", "4m 12s"), it.label); assertTrue(width(it) <= budget) }
        // Zooming in earns the richer wording; the queue points arrive last, only when the footprint has room.
        assertEquals(listOf("3 TRAINING", "4m 12s"), layout(training, .45f).label)
        assertEquals(listOf("3 TRAINING · 4m 12s"), layout(training, .8f).label)
        assertEquals(listOf("3 TRAINING · 4m 12s · 18/65"), layout(training, 1.2f).label)
        assertEquals(listOf("FULL 108/108"), layout(campChip("camp", ArmyStatus(readyPts = 108, campCapacityPts = 108)), .6f).label)
        // A large system font cannot widen the chip past its floor: the wording shrinks first, then the plate, never below legibility.
        layout(training, fontScale = 2f).let { assertEquals(listOf("3", "4m 12s"), it.label); assertTrue(it.scale >= ArmyChipMetrics.MIN_FIT - .05f) }
    }

    @Test fun `chip size is constant on screen through the zoom band and only follows the world at its ends`() {
        assertEquals(1f, armyChipScale(17f / 64)); assertEquals(1f, armyChipScale(1f))
        assertEquals(1.6f / ArmyChipMetrics.CLOSE_ZOOM, armyChipScale(1.6f), 1e-4f, "a close zoom is not dominated by a fixed plate")
        assertEquals(.5f, armyChipScale(ArmyChipMetrics.FAR_ZOOM / 2), 1e-4f)
        assertEquals(1f, armyChipScale(Float.NaN)); assertEquals(1f, armyChipScale(0f))
        val chip = campChip("camp", ArmyStatus(readyPts = 42, campCapacityPts = 108))
        assertNull(armyChipLayout(chip, ArmyChipMetrics.MIN_FOOTPRINT_DP - 1, .05f, 1f), "a miniature base is not littered with plates")
    }

    @Test fun `the roofline is the first painted row, not the top of the authored cell`() {
        val width = 4; val height = 6
        val pixels = IntArray(width * height).also { it[3 * width + 2] = 0x10FFFFFF; it[4 * width + 1] = 0xFF336699.toInt() }
        assertEquals(4, firstPaintedRow(pixels, width, height), "a faint antialias ghost is not the roof")
        assertNull(firstPaintedRow(IntArray(width * height), width, height))
        // A level 1 camp: 104×96 cell at scale 2 on a 2×2 footprint, first painted row 66 -> the roof is 60 world px above the south edge.
        val camp = RenderBuilding("camp", "bld_camp_l1", 10f, 10f, 2f, 2f)
        assertEquals(12 * 64f - (96 - 66) * 2f, roofWorldY(camp, 64f, 2f, 0f, 96, 66))
        assertEquals(12 * 64f + 3f - 96 * 2f, roofWorldY(camp, 64f, 2f, 3f, 96, 0), "a fully painted cell seats like the renderer's placeBuilding")
    }

    @Test fun `a chip icon is fitted to its painted pixels, not to the padding of its cell`() {
        val width = 8; val height = 6
        val pixels = IntArray(width * height).also { it[2 * width + 3] = 0xFF000000.toInt(); it[4 * width + 5] = 0x80FFFFFF.toInt(); it[0] = 0x08FFFFFF }
        assertEquals(listOf(3, 2, 6, 5), gg.pixelkingdomwars.nativeclient.ui.chrome.paintedBounds(pixels, width, height)?.toList())
        assertNull(gg.pixelkingdomwars.nativeclient.ui.chrome.paintedBounds(IntArray(width * height), width, height))
    }

    @Test fun `a tap the scene reports inside a chip opens that chip's building`() {
        val hits = ArmyChipHits(); val view = BaseCameraView("base-1", 640f, 640f, 1f, 1080, 2400)
        hits.place("camp-a", 500, 1100, 80, 30)
        fun tile(screen: Float, camera: Float, half: Float) = (screen - half + camera) / 64f
        assertEquals("camp-a", hits.buildingAt(view, tile(540f, 640f, 540f), tile(1110f, 640f, 1200f), 64f))
        assertNull(hits.buildingAt(view, tile(590f, 640f, 540f), tile(1110f, 640f, 1200f), 64f), "just right of the plate is ground")
        assertNull(hits.buildingAt(null, 10f, 10f, 64f))
        hits.retain(emptySet()); assertNull(hits.buildingAt(view, tile(540f, 640f, 540f), tile(1110f, 640f, 1200f), 64f))
    }
}
