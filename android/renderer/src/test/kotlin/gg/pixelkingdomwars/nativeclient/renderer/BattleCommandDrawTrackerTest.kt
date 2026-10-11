package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.math.Matrix4
import com.badlogic.gdx.math.Vector3
import kotlin.test.*
import org.junit.Test

class BattleCommandDrawTrackerTest {
    private fun tracker(aliases: Map<Int, Long> = mapOf(4 to 21L, 7 to 22L)) = requireNotNull(
        BattleCommandDrawTracker.create(BattleCommandDrawPlan(3, "raid", "revision", aliases), 10, "raid", "revision"))
    private fun BattleCommandDrawTracker.body(id: Int, alive: Boolean = true, alpha: Float = 1f, visible: Boolean = true) = drawn(id, alive, alpha, visible)
    private fun BattleCommandDrawTracker.end(active: Boolean = true) = submitted(10, "raid", "revision", active)

    @Test fun `only living positive alpha visible canonical mapped bodies count once after submission`() {
        val tracker = tracker()
        tracker.beginFrame()
        tracker.body(4, alive = false); tracker.body(4, alpha = 0f); tracker.body(4, alpha = -1f)
        tracker.body(4, alpha = Float.NaN); tracker.body(4, alpha = Float.POSITIVE_INFINITY)
        tracker.body(4, visible = false); tracker.body(99)
        assertNull(tracker.end())
        tracker.body(4); tracker.body(4); tracker.body(7)
        assertEquals(BattleCommandBodySubmission(3, "raid", "revision", listOf(21L, 22L)), tracker.end())
        tracker.beginFrame(); tracker.body(4); tracker.body(7)
        assertNull(tracker.end()); assertFalse(tracker.needs(4))
    }

    @Test fun `a failed body batch cannot acknowledge or carry its candidates into another frame`() {
        val tracker = tracker()
        tracker.beginFrame(); tracker.body(4)
        // batch.end throws: the renderer never calls submitted for that frame.
        tracker.beginFrame()
        assertNull(tracker.end()); assertTrue(tracker.needs(4))
        tracker.body(4)
        assertEquals(listOf(21L), tracker.end()!!.aliases)
    }

    @Test fun `stale generation identity and pause or disposal reject the frame without consuming a future valid draw`() {
        val tracker = tracker()
        for (reject in listOf<(BattleCommandDrawTracker) -> BattleCommandBodySubmission?>(
            { it.submitted(11, "raid", "revision", true) },
            { it.submitted(10, "other", "revision", true) },
            { it.submitted(10, "raid", "new-revision", true) },
            { it.end(active = false) },
        )) {
            tracker.beginFrame(); tracker.body(4); assertNull(reject(tracker))
            assertNull(tracker.end()); assertTrue(tracker.needs(4))
        }
        tracker.body(4); assertEquals(listOf(21L), tracker.end()!!.aliases)
    }

    @Test fun `revision local actor ids cannot inherit a newer or caller mutated alias map`() {
        val mutable = mutableMapOf(4 to 21L)
        val first = BattleCommandDrawPlan(3, "raid", "r1", mutable)
        mutable[4] = 22L
        val old = requireNotNull(BattleCommandDrawTracker.create(first, 1, "raid", "r1"))
        val next = requireNotNull(BattleCommandDrawTracker.create(BattleCommandDrawPlan(3, "raid", "r2", mutable), 2, "raid", "r2"))
        old.body(4); next.body(4)
        assertEquals(listOf(21L), old.submitted(1, "raid", "r1", true)!!.aliases)
        assertEquals(listOf(22L), next.submitted(2, "raid", "r2", true)!!.aliases)
        assertNull(BattleCommandDrawTracker.create(first, 2, "raid", "r2"))
        assertFails { (first.aliasesByActor as MutableMap<Int, Long>)[4] = 99L }
    }

    @Test fun `malformed and oversized diagnostic plans are ignored without changing scene admission`() {
        val invalid = listOf(
            BattleCommandDrawPlan(-1, "raid", "revision", mapOf(1 to 1L)),
            BattleCommandDrawPlan(1, "other", "revision", mapOf(1 to 1L)),
            BattleCommandDrawPlan(1, "raid", "other", mapOf(1 to 1L)),
            BattleCommandDrawPlan(1, "raid", "revision", emptyMap()),
            BattleCommandDrawPlan(1, "raid", "revision", mapOf(-1 to 1L)),
            BattleCommandDrawPlan(1, "raid", "revision", mapOf(1 to 0L)),
            BattleCommandDrawPlan(1, "raid", "revision", mapOf(1 to 2L, 2 to 2L)),
            BattleCommandDrawPlan(1, "raid", "revision", (0..BattleCommandDrawPlan.MAX_ALIASES).associateWith { it + 1L }),
        )
        invalid.forEach { assertNull(BattleCommandDrawTracker.create(it, 10, "raid", "revision")) }
        val full = (0 until BattleCommandDrawPlan.MAX_ALIASES).associateWith { it + 1L }
        val bounded = tracker(full)
        full.keys.forEach { bounded.body(it) }
        assertEquals(BattleCommandDrawPlan.MAX_ALIASES, bounded.end()!!.aliases.size)
    }

    private val art = Art("body", "atlas", 1f, 0f, 0f, 0f, 0f)
    private fun visible(placement: SpritePlacement = SpritePlacement(-50f, 0f, 100f, 100f, 0f),
        art: Art = this.art, trimX: Float = 0f, trimY: Float = 0f, width: Float = 20f, height: Float = 20f,
        projection: Matrix4 = Matrix4().setToOrtho2D(0f, 0f, 100f, 100f)) =
        commandBodyIntersectsViewport(art, placement, 100f, trimX, trimY, width, height, projection, Vector3())

    @Test fun `visible source padding is insufficient while a trimmed or flipped body quad really enters the viewport`() {
        assertFalse(visible()) // Full 100px source overlaps, but its 20px body is offscreen.
        assertTrue(visible(trimX = 60f))
        assertTrue(visible(art = art.copy(flipX = true))) // Flipped body lies at x30..50.
        assertFalse(visible(art = art.copy(flipX = true), trimX = 60f))
        assertFalse(visible(trimX = 60f, art = art.copy(cropWidth = 50f))) // No submitted width.
        assertFalse(visible(trimX = 60f, art = art.copy(rotation = 90f))) // Unmeasured current unsupported body geometry.
        assertFalse(visible(trimX = 60f, trimY = 101f))
        assertFalse(visible(trimX = 60f, height = 0f))
    }

    @Test fun `measurement follows active projection including shake scale and exact viewport edges`() {
        val seat = SpritePlacement(0f, 0f, 100f, 100f, 0f)
        assertTrue(visible(seat))
        val shifted = Matrix4().setToTranslation(3f, 0f, 0f).mul(Matrix4().setToOrtho2D(0f, 0f, 100f, 100f))
        assertFalse(visible(seat, projection = shifted))
        assertTrue(commandBodyIntersectsClip(0.5f, 0.5f, -0.5f, -0.5f))
        assertFalse(commandBodyIntersectsClip(-2f, 0f, -1f, 0.5f))
        assertFalse(commandBodyIntersectsClip(1f, 0f, 2f, 0.5f))
        assertFalse(commandBodyIntersectsClip(0f, 1f, 0.5f, 2f))
        assertFalse(commandBodyIntersectsClip(0f, 0f, Float.NaN, 0.5f))
        assertFalse(commandBodyIntersectsClip(0f, 0f, 0.5f, Float.POSITIVE_INFINITY))
        assertFalse(visible(seat, art = art.copy(scale = 0f)))
    }
}
