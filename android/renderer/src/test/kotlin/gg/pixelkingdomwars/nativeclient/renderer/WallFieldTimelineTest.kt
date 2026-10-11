package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import java.io.File
import org.junit.Test
import kotlin.test.*

/** The wall field is the web's `WallLayer` + `BattleScene.retileSurvivingWalls`/`onDestroyed` as a pure
 * timeline: tiers from the catalogue table, damage stages only from authoritative health, breaches
 * frozen before adjacency changes. Every frame key must rebuild its own pixels from the 3×3 context. */
class WallFieldTimelineTest {
    private val root = System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val render = JsonReader().parse(root.resolve("render-catalog.json").readText())
    private val spec = WallArtSpec(assertNotNull(render.get("walls5"), "contract 13 pack carries the walls5 section"))
    private val compositor = WallCompositor(spec)
    private val library = WallFrameLibrary(compositor)
    private fun wall(id: String, x: Int, y: Int, level: Int, hp: Long? = null, maxHp: Long? = null) =
        RenderBuilding(id, "wall5_t1_straight_intact_f1", x.toFloat(), y.toFloat(), 1f, 1f, hp, maxHp, type = "wall", level = level)
    private fun hit(tick: Int, target: String, dmg: Long) = PresentationEvent.fromJson("""{"t":$tick,"e":"hit","target":"$target","dmg":$dmg}""")
    private fun breach(tick: Int, id: String) = PresentationEvent.fromJson("""{"t":$tick,"e":"destroyed","id":"$id"}""")
    private fun live(ref: WallFrameRef?) = assertIs<WallFrameRef.Live>(assertNotNull(ref))
    private fun signature(ref: WallFrameRef?) = live(ref).renderKey.split('|')[5]

    @Test fun `home walls take their tier from the catalogue table and stay intact without health`() {
        val buildings = listOf(wall("a", 4, 4, 1), wall("b", 5, 4, spec.levelsPerTier + 1), wall("c", 6, 4, 2 * spec.levelsPerTier + 1),
            RenderBuilding("keep", "bld_keep_l1", 8f, 8f, 2f, 2f, type = "keep", level = 3))
        val field = WallFieldTimeline(spec, buildings)
        assertEquals("1:0:1", signature(field.frameAt("a", 0f))); assertEquals("2:0:1", signature(field.frameAt("b", 0f))); assertEquals("3:0:1", signature(field.frameAt("c", 0f)))
        assertEquals("4,4|-|-|-|-|1:0:1|2:0:1|-|-|-", live(field.frameAt("a", 0f)).renderKey, "the key is the wallRenderKey of the whole grid")
        assertNull(field.frameAt("keep", 0f), "only walls enter the field"); assertFalse(field.isEmpty)
        assertEquals(3, field.keys.size)
        assertTrue(WallFieldTimeline(spec, listOf(RenderBuilding("keep", "bld_keep_l1", 8f, 8f, 2f, 2f, type = "keep", level = 3))).isEmpty)
    }

    @Test fun `every frame key rebuilds the pixels the full grid composes`() {
        val grid = WallGrid()
        val buildings = mutableListOf<RenderBuilding>()
        val tiers = listOf(1, 3, 5, 2, 4)
        // A dense block, a cross and a mixed-tier row with damaged cells: shoulders, collars and chips
        // all reach across cell edges, so a key that dropped context would compose different pixels.
        val cells = (0..2).flatMap { y -> (0..2).map { x -> Triple(x, y, tiers[(x + y) % 5]) } } +
            listOf(Triple(6, 1, 2), Triple(5, 1, 2), Triple(7, 1, 2), Triple(6, 0, 2), Triple(6, 2, 2)) +
            listOf(Triple(10, 5, 1), Triple(11, 5, 5), Triple(12, 5, 3), Triple(13, 5, 4))
        cells.forEachIndexed { i, (x, y, tier) ->
            val damaged = i % 4 == 1; val heavy = i % 8 == 5
            val maxHp = 4000L; val hp = if (heavy) 500L else if (damaged) 1500L else maxHp
            grid.put(x, y, WallCell(tier, damaged, if (heavy) 2 else 1))
            buildings += wall("w$i", x, y, (tier - 1) * spec.levelsPerTier + 1, hp, maxHp)
        }
        val field = WallFieldTimeline(spec, buildings)
        for ((i, cell) in cells.withIndex()) {
            val ref = live(field.frameAt("w$i", 0f))
            assertEquals(compositor.renderKey(grid, cell.first, cell.second), ref.renderKey)
            val expected = assertNotNull(compositor.composeWall(grid, cell.first, cell.second))
            assertContentEquals(expected.data, library.pixels(ref.key), "w$i ${ref.renderKey}")
        }
        assertEquals(cells.size, library.size)
    }

    @Test fun `hits change the stage at the catalogue thresholds and recompose only the neighbourhood`() {
        val maxHp = 4000L
        val buildings = listOf(wall("a", 3, 3, 9, maxHp, maxHp), wall("b", 4, 3, 9, maxHp, maxHp), wall("c", 5, 3, 9, maxHp, maxHp), wall("far", 9, 9, 9, maxHp, maxHp))
        val light = (maxHp * spec.lightDamageBelow).toLong(); val heavy = (maxHp * spec.heavyDamageBelow).toLong()
        val events = listOf(hit(5, "b", maxHp - light), hit(10, "b", 1), hit(20, "b", light - heavy - 1), hit(30, "b", 1))
        val field = WallFieldTimeline(spec, buildings, events, tickDurationMs = 100f)
        val before = live(field.frameAt("a", 0f))
        assertEquals("3:0:1", signature(field.frameAt("b", 9f)), "exactly the light threshold is still intact")
        assertEquals("3:1:1", signature(field.frameAt("b", 10f))); assertEquals("3:1:1", signature(field.frameAt("b", 29f)))
        assertEquals("3:1:2", signature(field.frameAt("b", 30f)))
        assertEquals(before, field.frameAt("a", 9f), "an intact neighbour keeps its frame until the stage changes")
        assertNotEquals(before, field.frameAt("a", 10f), "a neighbour's stage recomposes the shared shoulder")
        assertEquals(live(field.frameAt("a", 10f)).renderKey.replace("3:1:1", "3:1:2"), live(field.frameAt("a", 30f)).renderKey)
        assertEquals(field.frameAt("far", 0f), field.frameAt("far", 100f), "a distant wall never recomposes")
        assertEquals(field.frameAt("c", 30f), field.frameAt("c", 31f))
        assertEquals(4 + 3 + 3, field.keys.size, "four initial frames, then the three-cell neighbourhood recomposes at each stage change")
    }

    @Test fun `a breach freezes the pre breach geometry into the collapse clock and survivors retile at once`() {
        val buildings = listOf(wall("a", 3, 3, 1), wall("b", 4, 3, 1), wall("c", 5, 3, 1))
        val field = WallFieldTimeline(spec, buildings, listOf(breach(10, "b")), tickDurationMs = 100f)
        val intact = live(field.frameAt("b", 9f))
        val falling = assertIs<WallFrameRef.Collapse>(assertNotNull(field.frameAt("b", 10f)))
        assertEquals(intact.renderKey, falling.renderKey, "the collapse snapshot is the pre-breach neighbourhood")
        assertEquals(0, falling.frame)
        assertEquals(1, assertIs<WallFrameRef.Collapse>(field.frameAt("b", 11f)).frame)
        assertEquals(2, assertIs<WallFrameRef.Collapse>(field.frameAt("b", 12f)).frame)
        assertEquals(spec.collapseFrames - 1, assertIs<WallFrameRef.Collapse>(field.frameAt("b", 13f)).frame)
        assertEquals(spec.collapseFrames - 1, assertIs<WallFrameRef.Collapse>(field.frameAt("b", 500f)).frame, "final rubble persists")
        assertEquals(intact, field.frameAt("b", 5f), "seeking back restores the intact frame")
        // A seek that lands past the breach jumped over it: the web's `collapse(id, jumping)` snaps to the
        // final rubble instead of squashing from a breach nobody watched; a breach after the floor animates.
        assertEquals(spec.collapseFrames - 1, assertIs<WallFrameRef.Collapse>(field.frameAt("b", 11f, seekFloor = 10f)).frame, "a breach at the seek tick is jumped")
        assertEquals(spec.collapseFrames - 1, assertIs<WallFrameRef.Collapse>(field.frameAt("b", 10f, seekFloor = 12f)).frame)
        assertEquals(1, assertIs<WallFrameRef.Collapse>(field.frameAt("b", 11f, seekFloor = 9f)).frame, "a breach after the floor plays its squash")
        assertEquals(intact, field.frameAt("b", 5f, seekFloor = 12f), "seeking back before the breach restores the intact frame whatever the floor")
        assertEquals("3,3|-|-|-|-|1:0:1|1:0:1|-|-|-", live(field.frameAt("a", 9f)).renderKey)
        assertEquals("3,3|-|-|-|-|1:0:1|-|-|-|-", live(field.frameAt("a", 10f)).renderKey, "survivors lose the breached neighbour at the breach tick")
        assertEquals(live(field.frameAt("a", 10f)), field.frameAt("a", 999f))
        val collapseKeys = (0 until spec.collapseFrames).map { WallFrameRef.collapseKey(intact.renderKey, it) }
        assertTrue(field.keys.containsAll(collapseKeys)); assertEquals(collapseKeys.size + 2 + 2 + 1, field.keys.size)
        // The library composes each frame from the frozen snapshot at the web layer's sample times.
        val (grid, x, y) = compositor.gridFromKey(intact.renderKey)
        val snapshot = assertNotNull(compositor.captureCollapse(grid, x, y))
        for (frame in 0 until spec.collapseFrames)
            assertContentEquals(compositor.composeCollapse(snapshot, spec.collapseFrameTimeMs(frame)).data, library.pixels(collapseKeys[frame]), "collapse frame $frame")
        assertEquals(0.0, spec.collapseFrameTimeMs(0)); assertEquals(spec.collapseDurationMs, spec.collapseFrameTimeMs(spec.collapseFrames - 1))
        assertEquals(spec.collapseDurationMs / (spec.collapseFrames - 1), spec.collapseFrameTimeMs(1), 1e-9)
        assertEquals(0, spec.collapseFrameAt(-5.0)); assertEquals(0, spec.collapseFrameAt(50.0)); assertEquals(2, spec.collapseFrameAt(200.0))
        assertEquals(spec.collapseFrames - 1, spec.collapseFrameAt(spec.collapseDurationMs * 10))
    }

    @Test fun `numeric targets health less walls and repeated breaches are ignored while malformed fields are refused`() {
        val buildings = listOf(wall("a", 3, 3, 1), wall("1", 4, 3, 1, 100L, 100L))
        val field = WallFieldTimeline(spec, buildings, listOf(
            PresentationEvent.fromJson("""{"t":1,"e":"hit","target":1,"dmg":90}"""), hit(2, "a", 90), breach(3, "1"), breach(4, "1"), hit(5, "1", 5)), 100f)
        assertEquals("1:0:1", signature(field.frameAt("1", 2f)), "a troop id that reads like a building name is not this wall")
        assertEquals("1:0:1", signature(field.frameAt("a", 2f)), "a wall without authoritative health never infers damage")
        assertIs<WallFrameRef.Collapse>(field.frameAt("1", 4f))
        assertEquals(field.frameAt("a", 3f), field.frameAt("a", 5f))
        assertTrue(field.diagnostics.isEmpty(), "well-formed input leaves nothing to report")
        assertFailsWith<IllegalArgumentException> { WallFieldTimeline(spec, listOf(wall("a", 3, 3, 1), wall("b", 3, 3, 1))) }
        assertFailsWith<IllegalArgumentException> { WallFieldTimeline(spec, listOf(wall("a", 3, 3, 1)), listOf(breach(4, "a"), breach(3, "a"))) }
        assertFailsWith<IllegalArgumentException> { WallFieldTimeline(spec, listOf(wall("a", 3, 3, 1, 5L, 4L))) }
        assertFailsWith<IllegalArgumentException> { compositor.gridFromKey("3,3|-|-") }
    }

    @Test fun `a hit without a usable dmg does no presentation damage and is reported instead of failing the battle`() {
        // The web's onHit applies `hp - dmg` without validation and keeps playing; the sim always emits whole
        // damage today, so an older log or a future revision must degrade to "no damage shown", never to
        // an unrenderable battle. Every other invariant (health, ordering, cells) still fails loudly.
        val maxHp = 4000L
        val field = WallFieldTimeline(spec, listOf(wall("a", 3, 3, 9, maxHp, maxHp)), listOf(
            PresentationEvent.fromJson("""{"t":1,"e":"hit","target":"a"}"""),
            PresentationEvent.fromJson("""{"t":2,"e":"hit","target":"a","dmg":"3000"}"""),
            PresentationEvent.fromJson("""{"t":3,"e":"hit","target":"a","dmg":2500.5}"""),
            PresentationEvent.fromJson("""{"t":4,"e":"hit","target":"a","dmg":-3000}"""),
            hit(5, "a", 3001)), 100f)
        for (tick in 1..4) assertEquals("3:0:1", signature(field.frameAt("a", tick.toFloat())), "tick $tick shows no damage the server did not state")
        assertEquals("3:1:2", signature(field.frameAt("a", 5f)), "a later whole dmg still lowers the authoritative mirror")
        assertEquals(4, field.diagnostics.size)
        assertTrue(field.diagnostics[0].contains("wall a at tick 1") && field.diagnostics[0].contains("no dmg"), field.diagnostics[0])
        assertTrue(field.diagnostics.drop(1).all { it.contains("not a whole non-negative number") }, field.diagnostics.toString())
        assertEquals(1 + 1, field.keys.size, "the tolerated hits composed nothing")
    }

    @Test fun `the library keeps only resolved pixels for the scene on show and recomposes an evicted key on demand`() {
        val shared = WallFrameLibrary(compositor)
        val first = WallFieldTimeline(spec, listOf(wall("a", 3, 3, 1), wall("b", 4, 3, 1)))
        val second = WallFieldTimeline(spec, listOf(wall("c", 9, 9, 5), wall("a", 3, 3, 1), wall("b", 4, 3, 1)))
        shared.prepare(first.keys); shared.prepare(second.keys)
        assertEquals(3, shared.size, "keys shared between bases are composed once")
        val pixels = shared.pixels(second.keys.first { it.startsWith("9,9") })
        assertEquals(spec.tile * spec.contextFrameHeight * 4, pixels.size, "a resident frame is its RGBA alone; the command list is not retained")
        assertContentEquals(assertNotNull(compositor.composeWall(compositor.gridFromKey(second.keys.first { it.startsWith("9,9") }).grid, 9, 9)).data, pixels)
        shared.retain(first.keys)
        assertEquals(2, shared.size, "frames of a base no longer shown are released with their atlas cells (the web frees WallLayer textures per scene)")
        assertContentEquals(pixels, shared.pixels(second.keys.first { it.startsWith("9,9") }), "an evicted key rebuilds identical pixels from its own 3×3 context")
        assertEquals(3, shared.size)
        shared.retain(emptySet()); assertEquals(0, shared.size)
    }

    @Test fun `prepared scene pixels survive later worker eviction without GL composition`() {
        val field = WallFieldTimeline(spec, listOf(wall("a",3,3,1),wall("b",4,3,1)))
        val delivery = library.snapshot(field.keys)
        val expected = delivery.mapValues { it.value.copyOf() }
        library.snapshot(emptySet())
        assertEquals(0,library.size)
        assertEquals(field.keys,delivery.keys)
        expected.forEach { (key,bytes) -> assertContentEquals(bytes,delivery.getValue(key)) }
    }

    @Test fun `the page mirror holds every resident frame at its cell so a context loss reload restores them`() {
        val layout = WallFrameAtlasLayout(spec.tile, spec.contextFrameHeight, 1024)
        val pageWidth = layout.columns * layout.cellWidth; val pageHeight = layout.rows * layout.cellHeight
        val page = java.nio.ByteBuffer.allocate(pageWidth * pageHeight * 4)
        val field = WallFieldTimeline(spec, listOf(wall("a", 3, 3, 1), wall("b", 4, 3, 3), wall("c", 5, 3, 5)))
        val (a, b, c) = listOf("a", "b", "c").map { library.pixels(assertNotNull(field.frameAt(it, 0f)).key) }
        assertTrue(a.any { it != 0.toByte() } && !a.contentEquals(b) && !b.contentEquals(c))
        val second = layout.columns + 1 // second row, second column: both offsets in play
        writeWallFrameCell(page, pageWidth, layout, 0, a)
        writeWallFrameCell(page, pageWidth, layout, second, b)
        val rowBytes = layout.cellWidth * 4
        fun cell(slot: Int): ByteArray {
            val out = ByteArray(rowBytes * layout.cellHeight)
            for (row in 0 until layout.cellHeight) System.arraycopy(page.array(), ((layout.y(slot) + row) * pageWidth + layout.x(slot)) * 4, out, row * rowBytes, rowBytes)
            return out
        }
        assertContentEquals(a, cell(0), "slot 0 mirrors frame a row by row at the page's own row pitch")
        assertContentEquals(b, cell(second), "a cell on the second row sits at (cellWidth, cellHeight)")
        assertTrue(cell(1).all { it == 0.toByte() } && cell(layout.columns).all { it == 0.toByte() }, "neighbouring cells stay untouched")
        assertEquals(0, page.position(), "the buffer is left rewound for the GL upload")
        writeWallFrameCell(page, pageWidth, layout, 0, c)
        assertContentEquals(c, cell(0), "a reused cell carries the frame that now owns it, which is what the reload must upload")
        assertContentEquals(b, cell(second))
        assertFailsWith<IllegalArgumentException> { writeWallFrameCell(page, pageWidth, layout, 0, ByteArray(3)) }
        assertFailsWith<IllegalArgumentException> { writeWallFrameCell(page, pageWidth - 1, layout, 0, a) }
    }

    @Test fun `atlas pages keep referenced cells and reuse released ones before opening a page`() {
        val layout = WallFrameAtlasLayout(spec.tile, spec.contextFrameHeight, 1024)
        assertEquals(1024 / spec.tile, layout.columns); assertEquals(1024 / spec.contextFrameHeight, layout.rows)
        val perPage = layout.cellsPerPage
        assertEquals(0, layout.page(perPage - 1)); assertEquals(1, layout.page(perPage))
        assertEquals(spec.tile, layout.x(layout.columns + 1)); assertEquals(spec.contextFrameHeight, layout.y(layout.columns + 1))
        assertEquals(0, layout.x(perPage)); assertEquals(0, layout.y(perPage), "a new page starts at its origin")
        val index = WallFrameAtlasIndex(layout)
        assertEquals(0 to true, index.allocate("a")); assertEquals(1 to true, index.allocate("b"))
        assertEquals(0 to false, index.allocate("a"), "a resident key keeps its cell without a second upload")
        index.retain(setOf("b")); assertNull(index.cell("a"))
        assertEquals(0 to true, index.allocate("c"), "released cells are reused before the page grows")
        assertEquals(2 to true, index.allocate("d")); assertEquals(1, index.pages)
        index.clear(); assertEquals(0, index.pages); assertNull(index.cell("b"))
        assertFailsWith<IllegalArgumentException> { WallFrameAtlasLayout(spec.tile, spec.contextFrameHeight, 16) }
    }
}
