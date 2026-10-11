package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.bits
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.hx
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.list
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The JavaScript number semantics the classifier port stands on, bit for bit against the pinned web code
 * (`math.json`). Why it matters: the web and the Seeker must draw the same tree on the same tile and the same coast on
 * the same vertex; one ulp in a hash, a noise or `Math.hypot` flips a class at a threshold, and a flipped class moves
 * a shore, a forest edge or a river bank between the two clients.
 */
class GroundMathTest {
    private val g = GroundGolden.suite("math")

    @Test fun `Math hypot is V8's normalised Kahan sum, not fdlibm hypot`() {
        var n = 0
        for (row in list(g.get("hypot"))) {
            val a = hx(row.getString(0)); val b = hx(row.getString(1))
            assertEquals(row.getString(2), bits(GroundMath.jsHypot(a, b)), "hypot(${a}, $b)"); n++
        }
        assertEquals(1000, n)
        // teeth: fdlibm's hypot (StrictMath) is a different function; it must disagree somewhere in the set, or this suite
        // would not be able to tell the two apart
        val differs = list(g.get("hypot")).count { row -> bits(StrictMath.hypot(hx(row.getString(0)), hx(row.getString(1)))) != row.getString(2) }
        assertTrue(differs > 0, "StrictMath.hypot agrees on every sample: the suite has no teeth")
    }

    @Test fun `value noise and zig-zag noise are the web's to the bit`() {
        var n = 0
        for (row in list(g.get("noise"))) {
            val x = hx(row.getString(0)); val y = hx(row.getString(1)); val p = hx(row.getString(2)); val seed = row.getInt(3)
            assertEquals(row.getString(4), bits(GroundMath.vnoise(x, y, p, seed)), "vnoise($x, $y, $p, $seed)")
            assertEquals(row.getString(5), bits(GroundMath.znoise(x, y, p, seed)), "znoise($x, $y, $p, $seed)")
            n++
        }
        assertEquals(700, n)
    }

    @Test fun `kitHash and pcg2d are the kit's integer hashes over the whole int32 range`() {
        var n = 0
        for (row in list(g.get("hashes"))) {
            val a = row.getInt(0); val b = row.getInt(1)
            assertEquals(row.getInt(2), GroundMath.kitHash(a, b), "kitHash($a, $b)")
            assertEquals(row.getInt(3), GroundMath.pcg2dX(a, b), "pcg2d($a, $b)")
            n++
        }
        assertEquals(500, n)
    }

    @Test fun `half floats round to nearest even through float32, as the baked line pages are uploaded`() {
        var n = 0
        for (row in list(g.get("half"))) {
            val v = hx(row.getString(0))
            val h = ClassBake.toHalf(v)
            assertEquals(row.getInt(1), h, "toHalf($v)")
            assertEquals(row.getString(2), bits(ClassBake.fromHalf(h)), "fromHalf(toHalf($v))")
            n++
        }
        assertEquals(400, n)
    }

    @Test fun `a land bridge packs into the one header word the GPU reads, and unpacks to the JS reference's float32 values`() {
        var n = 0
        for (row in list(g.get("bridges"))) {
            val ux = hx(row.getString(0)); val uy = hx(row.getString(1)); val len = hx(row.getString(2)); val hw = hx(row.getString(3))
            val u = ClassBake.packBridge(ux, uy, len, hw)
            assertEquals(row.getInt(4), u, "packBridge($ux, $uy, $len, $hw)")
            val d = ClassBake.unpackBridge(u)
            for (k in 0 until 4) assertEquals(row.getString(5 + k), bits(d[k]), "unpackBridge($u)[$k]")
            n++
        }
        assertEquals(400, n)
    }

    @Test fun `Math round rounds half up exactly as V8`() {
        var n = 0
        for (row in list(g.get("round"))) { assertEquals(row.getString(1), bits(GroundMath.jsRound(hx(row.getString(0)))), "round(${hx(row.getString(0))})"); n++ }
        assertEquals(11, n)
    }

    /**
     * V8's `Math.atan2` matches fdlibm ([StrictMath]) bit for bit here; its `Math.sin` / `Math.cos` do not (V8's own libm trig
     * port): they differ from fdlibm in the last bit on a few arguments. The classifier uses sin/cos only for the clearing's and the
     * island's per-deed lobes and the bridge directions, where one ulp moves a radius by ~1e-16 t: the real-pack golden
     * (ClassifyGoldenTest, 58,368 vertices and their intermediate doubles) matches exactly. This pins the size of the gap:
     * every sample within one ulp, and the differing ones few, so a regression to a coarser sin/cos fails here.
     */
    @Test fun `trig matches V8 - atan2 bit for bit, sin and cos within one ulp on every sample`() {
        var n = 0; var cosOff = 0; var sinOff = 0
        for (row in list(g.get("trig"))) {
            val t = hx(row.getString(0))
            val c = StrictMath.cos(t); val s = StrictMath.sin(t); val wc = hx(row.getString(1)); val ws = hx(row.getString(2))
            assertTrue(c == wc || Math.abs(c - wc) <= Math.ulp(wc), "cos($t): $c vs V8 $wc"); if (c != wc) cosOff++
            assertTrue(s == ws || Math.abs(s - ws) <= Math.ulp(ws), "sin($t): $s vs V8 $ws"); if (s != ws) sinOff++
            assertEquals(row.getString(3), bits(StrictMath.atan2(ws * 3, wc - 0.2)), "atan2 at $t")
            n++
        }
        assertEquals(200, n)
        assertTrue(cosOff + sinOff <= 8, "$cosOff cos and $sinOff sin samples differ from V8 by one ulp (more than the known handful)")
        // the bridge rays' 24 fixed directions (classify.js bridgeOf, TAU·k/24) are V8's to the bit
        var d = 0
        for (row in list(g.get("dirs"))) {
            val th = GroundMath.TAU * row.getInt(0) / 24
            assertEquals(row.getString(1), bits(StrictMath.cos(th)), "cos of ray ${row.getInt(0)}"); assertEquals(row.getString(2), bits(StrictMath.sin(th)), "sin of ray ${row.getInt(0)}"); d++
        }
        assertEquals(24, d)
    }

    @Test fun `JS ToInt32 wraps modulo 2^32 and truncates toward zero`() {
        assertEquals(0, GroundMath.toInt32(Double.NaN)); assertEquals(0, GroundMath.toInt32(Double.POSITIVE_INFINITY))
        assertEquals(-2147483648, GroundMath.toInt32(2147483648.0)); assertEquals(1, GroundMath.toInt32(4294967297.0))
        assertEquals(-3, GroundMath.toInt32(-3.9)); assertEquals(3, GroundMath.toInt32(3.9))
    }
}
