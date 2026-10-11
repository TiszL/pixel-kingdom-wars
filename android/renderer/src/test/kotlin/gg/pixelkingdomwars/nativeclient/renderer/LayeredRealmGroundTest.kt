package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import org.junit.Test
import kotlin.test.*

class LayeredRealmGroundTest {
    private fun fixture(): JsonValue {
        fun asset(id: String, hash: String, count: Int) = """{"id":"$id","path":"atlas/fantasy/layered-ground/assets/$hash.webp","sha256":"$hash","size":100,
            "width":${count * 2},"height":2,"frameWidth":2,"frameHeight":2,"frameCount":$count,"frameDurationMs":100,"anchor":{"x":1,"y":2},"reducedMotionFrame":0}"""
        return JsonReader().parse("""{"schemaVersion":1,"groundRevision":3,"realmId":"thornwake","status":"preview-only","tilePixels":32,
            "field":{"x":-1088,"y":-1088,"width":3136,"height":3136},"protectedFrame":{"x":-256,"y":-256,"width":1472,"height":1472},
            "ground":{"asset":"ground","sampling":"world"},"assets":[${asset("ground", "a".repeat(64), 1)},${asset("water", "b".repeat(64), 2)}],
            "placements":[{"id":"waterfall","asset":"water","x":-298,"y":-296,"width":4,"height":4,"layer":1,"phaseFrame":1,"animated":true,"interactive":false}]}""")
    }
    @Test fun `source anchors scale by catalogue tile size and match shared frame geometry`() {
        val ground = LayeredRealmGround(fixture())
        val view = LayeredGroundRect(-610.0, -610.0, 30.0, 30.0)
        val draw = ground.drawPlan(64.0, view, 0, false).single()
        assertEquals(LayeredGroundRect(-600.0, -600.0, 8.0, 8.0), draw.destination)
        assertEquals(1, draw.frame); assertEquals(2.0, draw.source.x)
        assertEquals(LayeredGroundRect(-2176.0, -2176.0, 6272.0, 6272.0), ground.floorBounds(64.0))
        assertEquals(0, ground.drawPlan(64.0, view, 999, true).single().frame)
        assertTrue(ground.drawPlan(64.0, view, 0, false, true).isEmpty())
        assertTrue(ground.drawPlan(64.0, LayeredGroundRect(0.0, 0.0, 960.0, 960.0), 0, false).isEmpty())
        // Tiny metadata fixtures still animate, but cannot provide an inward
        // clean texel; never fall back to scenic edge pixels for exterior ground.
        assertFailsWith<IllegalArgumentException> { ground.floorPlan(64.0, LayeredGroundRect(-2200.0, -2200.0, 7000.0, 7000.0)) }
    }
    @Test fun `clean material matches shared 2D coverage and preserves the entire authored painting`() {
        val v = fixture(); val a = v.get("assets").get(0)
        for (key in listOf("width", "height", "frameWidth", "frameHeight")) { a.remove(key); a.addChild(key, JsonValue(98L)) }
        val p = v.get("protectedFrame")
        for ((key, n) in mapOf("x" to -320L, "y" to -320L, "width" to 1600L, "height" to 1600L)) { p.remove(key); p.addChild(key, JsonValue(n)) }
        v.remove("placements"); v.addChild("placements", JsonValue(JsonValue.ValueType.array))
        val g = LayeredRealmGround(v)
        assertEquals(LayeredGroundRect(24.0, 24.0, 50.0, 50.0), g.cleanGroundCrop())
        val view = LayeredGroundRect(-2600.0, -2600.0, 8000.0, 8000.0)
        val draws = g.floorPlan(64.0, view); val center = draws.single { it.id == "floor-c-c" }
        assertEquals(LayeredGroundRect(0.0, 0.0, 98.0, 98.0), center.source)
        assertEquals(LayeredGroundRect(-2176.0, -2176.0, 6272.0, 6272.0), center.destination)
        assertFalse(center.flipX || center.flipY)
        for (d in draws.filter { it != center }) {
            assertFalse(d.destination.intersects(center.destination))
            assertTrue(d.source.x >= 24 && d.source.y >= 24 && d.source.x + d.source.width <= 74 && d.source.y + d.source.height <= 74)
            assertTrue(listOf(d.source.x, d.source.y, d.source.width, d.source.height).all { it == kotlin.math.floor(it) })
            assertFalse(d.flipX || d.flipY)
            assertEquals(d, g.floorPlan(64.0, view.copy(x = view.x + 1)).single { it.id == d.id })
        }
        for (wide in listOf(LayeredGroundRect(-11000.0, -2176.0, 24000.0, 6272.0),
            LayeredGroundRect(-2176.0, -11000.0, 6272.0, 24000.0))) {
            val coverage = g.floorPlan(64.0, wide); assertTrue(coverage.size < 100)
            for (y in (wide.y.toInt() + 1) until (wide.y + wide.height).toInt() step 379)
                for (x in (wide.x.toInt() + 1) until (wide.x + wide.width).toInt() step 379)
                    assertEquals(1, coverage.count { it.destination.intersects(LayeredGroundRect(x.toDouble(), y.toDouble(), .01, .01)) })
        }
        assertFailsWith<IllegalArgumentException> { g.floorPlan(64.0, view.copy(width = 1e12)) }
        assertFailsWith<IllegalArgumentException> { g.floorPlan(64.0, view.copy(x = Double.POSITIVE_INFINITY)) }
        assertFailsWith<IllegalArgumentException> { g.floorPlan(64.0, LayeredGroundRect(-100000.0, -100000.0, 200000.0, 200000.0)) }
        fun clean(index: Int) = 24 + ((index - 24) % 50 + 50) % 50
        // Identical shared/server probes include one-axis overflow beside scenic
        // rows/columns, negative periods, every original source seat and corners.
        for (ix in -180 until 280) for (iy in listOf(0, 23, 49, 74, 97, 279 - ix)) {
            val x = -1088 + (ix + .5) * 32; val y = -1088 + (iy + .5) * 32
            val d = g.floorPlan(64.0, LayeredGroundRect(x * 2, y * 2, .01, .01)).single()
            val outside = ix !in 0 until 98 || iy !in 0 until 98
            assertEquals(if (outside) clean(ix) else ix, kotlin.math.floor(d.source.x + (x * 2 - d.destination.x) * d.source.width / d.destination.width).toInt())
            assertEquals(if (outside) clean(iy) else iy, kotlin.math.floor(d.source.y + (y * 2 - d.destination.y) * d.source.height / d.destination.height).toInt())
        }
        for (key in listOf("width", "height", "frameWidth", "frameHeight")) { a.remove(key); a.addChild(key, JsonValue(1254L)) }
        val actual = LayeredRealmGround(v)
        assertEquals(LayeredGroundRect(308.0, 308.0, 638.0, 638.0), actual.cleanGroundCrop())
        for (index in listOf(-1900, -615, -614, -308, -307, -2, -1, 0, 500, 1253, 1254, 1560, 1561, 1867, 2500)) {
            val world = -1088 + (index + .5) * 3136 / 1254
            val d = actual.floorPlan(64.0, LayeredGroundRect(world * 2, world * 2, .01, .01)).single()
            val expected = if (index in 0 until 1254) index else 308 + ((index - 308) % 638 + 638) % 638
            assertEquals(expected, kotlin.math.floor(d.source.x + (world * 2 - d.destination.x) * d.source.width / d.destination.width).toInt())
        }
    }
    @Test fun `reject overflow before narrowing and enforce protected clear frame`() {
        val overflow = fixture(); overflow.get("assets").get(0).apply { remove("width"); addChild("width", JsonValue(4294967298L)) }
        assertFailsWith<IllegalArgumentException> { LayeredRealmGround(overflow) }
        val intrusion = fixture(); intrusion.get("placements").get(0).apply { remove("x"); addChild("x", JsonValue(0L)); remove("y"); addChild("y", JsonValue(0L)) }
        assertFailsWith<IllegalArgumentException> { LayeredRealmGround(intrusion) }
        val wrongRealm = fixture(); wrongRealm.get("realmId").set("unknown-realm")
        assertFailsWith<IllegalArgumentException> { LayeredRealmGround(wrongRealm) }
    }
    @Test fun `fractional authored image seats retain alignment and nonanimated layers stay still`() {
        val v = fixture(); val p = v.get("placements").get(0); p.remove("x"); p.addChild("x", JsonValue(-298.25)); p.get("animated").set(false)
        val g = LayeredRealmGround(v)
        val draw = g.drawPlan(64.0, LayeredGroundRect(-610.0, -610.0, 30.0, 30.0), Long.MAX_VALUE, false).single()
        assertEquals(-600.5, draw.destination.x); assertEquals(0, draw.frame)
    }
}
