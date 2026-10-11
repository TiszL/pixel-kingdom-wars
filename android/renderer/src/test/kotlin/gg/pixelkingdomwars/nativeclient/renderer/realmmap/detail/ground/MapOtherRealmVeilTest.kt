package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.DeedPx
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Kind
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldShaders
import org.junit.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Owner 2026-09-26 (Seeker code 31, Sunscar realm map at MAP zoom): "grey overlay is visible on current screen on realm
 * map and it looks ugly, neighbour is not visible at all here". Then (code 31b, Crownlands at the FAR overview, the D-177
 * landing): "check crownland also have that grey area on the edges, which sunscar had, fix it for all realms, sunscar does
 * not have it anymore while zoomed in but when you zoom out a bit you will see it again on this range".
 *
 * A realm's art paints land that the catalogue gives to another realm (Sunscar's northern coast, Crownlands' snow coast:
 * deeds mask 96, base state kind 2), and every per-deed other-realm veil greyed that land deed by deed, with hard
 * stair-stepped edges: MAP first (`if (bs.r == 2u) … * 0.88`, removed at c41c34a9), then the FAR chart (×0.85, and so the
 * chart → MAP crossfade on the way out), the minimap (×0.12 toward the sea) and the stand-in ground (×0.8). The web fix
 * 02e9da84 (the pin in world-shaders.lock.json) removes all of them. The rule now, at EVERY zoom and in EVERY realm: an
 * other-realm deed draws exactly as a cell with no deed does, as the realm art paints it. Only the soft foreign fade
 * (distance from THIS realm's deeds, not who owns a deed) still eases far land into the open sea.
 *
 * The rules run on the EXPORTED stages the native engine compiles (`WorldShaders`: the pin's own preprocessGLSL output),
 * so a re-pin that brings any veil back fails here before it reaches a Seeker. How: every read of a deed's realm (the
 * deeds mask through `uDeeds`, the base-state kind through `uRmBase`) is found in every exported stage, and every branch
 * on it is evaluated for an other-realm deed and for no deed; the two must agree (a port of the web ground.test.mjs
 * `otherRealmVeils`). A read or a use this checker cannot evaluate fails loud instead of passing. Each rule is shown to
 * catch a mutated stage.
 */
class MapOtherRealmVeilTest {
    private fun fs(key: String): String = WorldShaders.source((WorldShaders.realm[key] ?: fail("realm program $key is not exported")).fs)
    private fun code(src: String) = src.replace(Regex("/\\*[\\s\\S]*?\\*/"), " ").replace(Regex("//[^\\n]*"), "")

    /** Every MAP ground program: rm-map, Cinderfall's lava variant and the ?gdbg water-mask debug view (all include mapground). */
    private val maps = listOf(GroundPrograms.MAP, GroundPrograms.MAP_LAVA, "rm-map-wmask+RM_DBG_WMASK")
    private val trues = listOf(GroundPrograms.TRUE, "rm-true-wmask+RM_DBG_WMASK")
    private val chartKey = "rm-chart"

    /** A read of the other-realm kind of the base state: the only way MAP and TRUE can tell a deed is another realm's. */
    private val otherRealmRead = Regex("\\.r\\s*==\\s*2u\\b")
    /** The removed MAP veil's greying (a 25 % pull to luminance), however its condition is spelled. */
    private val greying = Regex("mix\\(\\s*col\\s*,\\s*vec3\\(\\s*lum\\(\\s*col\\s*\\)\\s*\\)")
    /** MAP's deed line (base state kind 1). While MAP still reads the base state this way, a missing kind-2 read is a real absence. */
    private val deedLine = Regex("if\\s*\\(\\s*bs\\.r\\s*==\\s*1u\\s*\\)")

    private fun veilsOtherRealm(src: String) = code(src).let { otherRealmRead.containsMatchIn(it) || greying.containsMatchIn(it) }

    // ---- the realm-read scanner (port of the web ground.test.mjs otherRealmVeils) ---------------------------------------

    private class Scan { val reads = mutableListOf<String>(); var branches = 0; val veils = mutableListOf<String>(); val problems = mutableListOf<String>() }

    private val realmRead = Regex("\\b(?:texelFetch|texture|textureLod)\\s*\\(\\s*(uDeeds|uRmBase)\\b")
    /** [an other-realm deed, no deed] as each source encodes a deed's realm: the deeds-mask byte, the base-state kind. */
    private val realmValues = mapOf("uDeeds" to (DeedPx.OTHER_REALM to DeedPx.NONE), "uRmBase" to (Kind.OTHER_REALM to Kind.NONE))
    private val declaration = Regex("^\\s*(?:(?:highp|mediump|lowp)\\s+)?\\w+\\s+(\\w+)\\s*=")

    private fun closeParen(s: String, open: Int): Int {
        var d = 0
        for (i in open until s.length) { if (s[i] == '(') d++ else if (s[i] == ')' && --d == 0) return i }
        return -1
    }
    private fun lineOf(s: String, i: Int) = s.substring(0, i).count { it == '\n' } + 1
    /** Comments blanked in place, so offsets and line numbers stay the stage's own. */
    private fun blank(src: String) = src.replace(Regex("/\\*[\\s\\S]*?\\*/|//[^\\n]*")) { m -> m.value.replace(Regex("[^\\n]"), " ") }

    private fun scan(raw: String): Scan {
        val s = blank(raw); val out = Scan()
        for (m in realmRead.findAll(s)) {
            val tex = m.groupValues[1]; val at = m.range.first
            val st0 = maxOf(s.lastIndexOf(';', at), s.lastIndexOf('{', at), s.lastIndexOf('}', at)) + 1
            val st1 = s.indexOf(';', at)
            val decl = if (st1 < 0) null else declaration.find(s.substring(st0, st1))
            if (decl == null) { out.problems += "${lineOf(s, at)}: a $tex read that is not a declaration: ${s.substring(st0, if (st1 < 0) s.length else st1).trim()}"; continue }
            val ch = Regex("^\\s*\\.([xyzwrgba]+)\\b").find(s.substring(closeParen(s, s.indexOf('(', at)) + 1))
            if (ch != null && ch.groupValues[1].none { it == 'r' || it == 'x' }) continue // reads other channels only (flags, claim, level)
            val scalar = ch != null; val name = decl.groupValues[1]; val (vOther, vNone) = realmValues.getValue(tex)
            out.reads += "$tex ${if (scalar) name else "$name.r"}"
            var end = st1 + 1; var depth = 0
            while (end < s.length) { if (s[end] == '{') depth++ else if (s[end] == '}' && --depth < 0) break; end++ }
            val judged = HashSet<Int>() // one verdict per branch (dv > 80u && dv < 128u is one)
            for (u in Regex("\\b$name\\b(\\s*\\.\\s*([xyzwrgba]+)\\b)?").findAll(s.substring(st1 + 1, end))) {
                val j = st1 + 1 + u.range.first
                val where = "${lineOf(s, j)}: ${s.substring(s.lastIndexOf('\n', j) + 1, s.indexOf('\n', j).let { if (it < 0) s.length else it }).trim()}"
                val sw = u.groups[2]?.value
                if (!scalar && sw == null) { out.problems += "$where ($name used whole)"; continue }
                if (!scalar && sw!!.none { it == 'r' || it == 'x' }) continue
                if (!scalar && sw!!.length != 1) { out.problems += "$where (swizzle $sw)"; continue }
                // the innermost if-condition or step() around this use
                var best: Triple<String, Int, Int>? = null
                for (c in Regex("\\b(if|step)\\s*\\(").findAll(s.substring(0, j))) {
                    val o = c.range.last; val cl = closeParen(s, o)
                    if (cl > j && (best == null || o > best.second)) best = Triple(c.groupValues[1], o, cl)
                }
                val found = best
                if (found == null) { out.problems += "$where (not in an if-condition or step())"; continue }
                val (kind, open, close) = found
                if (!judged.add(open)) continue
                val sym = Regex(if (scalar) "\\b$name\\b" else "\\b$name\\s*\\.\\s*[rx]\\b")
                val expr = s.substring(open + 1, close)
                fun value(v: Int): Double? {
                    val e = expr.replace(sym, v.toString()).replace(Regex("(\\d)u\\b"), "$1")
                    if (kind == "step") {
                        val a = e.split(',').map { it.trim() }
                        return if (a.size == 2 && a.all { it.matches(Regex("\\d+(?:\\.\\d*)?|\\.\\d+")) }) (if (a[1].toDouble() >= a[0].toDouble()) 1.0 else 0.0) else null
                    }
                    return Cond(e).eval()
                }
                val a = value(vOther); val b = value(vNone)
                if (a == null || b == null) { out.problems += "$where (cannot evaluate $kind(${expr.trim()}))"; continue }
                out.branches++
                if (a != b) out.veils += where
            }
        }
        return out
    }

    /**
     * A condition with the deed's value substituted: numbers, ! && || & | == != < <= > >= and parentheses only (the web's
     * `/^[\s\d.<>=!&|()]+$/`, JS precedence). Anything else (a function, a uniform, a ternary) answers null: fail loud.
     */
    private class Cond(src: String) {
        private val tokens: List<String> = buildList {
            val re = Regex("\\d+(?:\\.\\d*)?|\\.\\d+|\\|\\||&&|==|!=|<=|>=|[<>!()&|]")
            var i = 0
            while (i < src.length) {
                if (src[i].isWhitespace()) { i++; continue }
                val m = re.find(src, i)
                if (m == null || m.range.first != i) { add("?"); break } // anything else: unreadable, so eval() answers null
                add(m.value); i = m.range.last + 1
            }
        }
        private var k = 0
        private fun peek() = tokens.getOrNull(k)
        private fun num(v: Any) = when (v) { is Boolean -> if (v) 1.0 else 0.0; else -> v as Double }
        private fun truthy(v: Any) = num(v) != 0.0
        fun eval(): Double? = try { val v = or(); if (k != tokens.size) null else num(v) } catch (_: IllegalStateException) { null }
        private fun or(): Any { var v = and(); while (peek() == "||") { k++; val r = and(); v = truthy(v) || truthy(r) }; return v }
        private fun and(): Any { var v = bor(); while (peek() == "&&") { k++; val r = bor(); v = truthy(v) && truthy(r) }; return v }
        private fun bor(): Any { var v = band(); while (peek() == "|") { k++; v = (num(v).toInt() or num(band()).toInt()).toDouble() }; return v }
        private fun band(): Any { var v = eq(); while (peek() == "&") { k++; v = (num(v).toInt() and num(eq()).toInt()).toDouble() }; return v }
        private fun eq(): Any { var v = rel(); while (peek() == "==" || peek() == "!=") { val op = tokens[k++]; val r = rel(); v = (num(v) == num(r)) == (op == "==") }; return v }
        private fun rel(): Any {
            var v = unary()
            while (peek() in setOf("<", "<=", ">", ">=")) {
                val op = tokens[k++]; val a = num(v); val b = num(unary())
                v = when (op) { "<" -> a < b; "<=" -> a <= b; ">" -> a > b; else -> a >= b }
            }
            return v
        }
        private fun unary(): Any = when (val t = peek() ?: error("end")) {
            "!" -> { k++; !truthy(unary()) }
            "(" -> { k++; val v = or(); check(peek() == ")"); k++; v }
            else -> { check(t.first().isDigit() || t.first() == '.'); k++; t.toDouble() }
        }
    }

    /** Every exported stage once (vertex and fragment, realm engine and globe): stage file → its text. */
    private fun allStages(): Map<String, String> = (WorldShaders.realm.values + WorldShaders.globe.values)
        .flatMap { listOf(it.vs, it.fs) }.distinctBy { it.path }.associate { it.path to WorldShaders.source(it) }

    // ---- the rules ------------------------------------------------------------------------------------------------------

    @Test fun `MAP draws other-realm deeds as the realm art paints them - no rm-map variant veils them`() {
        for (key in maps) {
            val src = fs(key)
            assertTrue(deedLine.containsMatchIn(code(src)), "$key no longer draws the deed line from the base state, so this check would pass vacuously")
            assertFalse(veilsOtherRealm(src), "$key veils other-realm deeds again. Owner 2026-09-26: \"grey overlay is visible on current screen on realm map and it looks ugly\"")
        }
    }

    @Test fun `TRUE draws other-realm deeds unveiled, as it always did`() {
        for (key in trues) assertFalse(veilsOtherRealm(fs(key)), "$key veils other-realm deeds: MAP and TRUE must agree")
    }

    /**
     * The FAR chart, the minimap and the stand-in ground were the veils left after c41c34a9 (the owner's Crownlands FAR
     * screenshot is the chart's). The chart and the minimap no longer read a deed's realm at all; the stand-in still reads
     * the deeds mask for its deed lines (this realm's deeds only), and an other-realm deed takes the no-deed branch there.
     */
    @Test fun `the FAR chart, the minimap and the stand-in ground draw other-realm deeds unveiled`() {
        val quote = "Owner 2026-09-26: \"check crownland also have that grey area on the edges, which sunscar had, fix it for all realms\""
        for (key in listOf(chartKey, "minimap")) assertEquals(emptyList(), scan(fs(key)).reads, "$key reads a deed's realm again. $quote")
        val stub = scan(fs("stub-ground"))
        assertEquals(listOf("uDeeds dv"), stub.reads, "the stand-in's deed-line read is the one this rule judges")
        assertEquals(1, stub.branches, "the stand-in's deed line (dv > 200u) is judged")
        assertEquals(emptyList(), stub.veils + stub.problems, "stub-ground veils other-realm deeds. $quote")
    }

    @Test fun `no exported stage veils other-realm deeds, at any zoom`() {
        val scans = allStages().mapValues { scan(it.value) }
        assertEquals(emptyList(), scans.flatMap { (k, s) -> s.problems.map { "$k:$it" } }, "every read of a deed's realm is one this test can judge")
        assertEquals(emptyList(), scans.flatMap { (k, s) -> s.veils.map { "$k:$it" } }, "an other-realm deed takes exactly the branch a cell with no deed takes")
        // teeth: the scanner reaches the reads that remain (a regex that silently matched nothing would pass everything above)
        val reads = scans.flatMap { (k, s) -> s.reads.map { "$k $it" } }
        for (r in listOf("rm-map.fs.glsl uRmBase bs.r", "rm-map+RM_LAVA.fs.glsl uRmBase bs.r", "rm-true.fs.glsl uRmBase b.r",
                         "life-stand.vs.glsl uRmBase b.r", "stub-ground.fs.glsl uDeeds dv"))
            assertTrue(r in reads, "the scanner found $r (found: $reads)")
        assertTrue(scans.values.sumOf { it.branches } >= 4, "MAP's three deed lines and the stand-in's are judged")
    }

    /**
     * The CPU side: the native engine names the other realm only where it encodes it as data (the deeds mask, the
     * base-state kind) or checks a pack against it. A Kotlin path that dimmed by it (a CPU minimap, a chart fallback, a dot
     * alpha) would have to name it somewhere else.
     */
    @Test fun `only the realm encoders name the other realm on the CPU`() {
        val root = File("src/main/kotlin")
        assertTrue(root.isDirectory, "run from the renderer module (${File(".").absolutePath})")
        val named = root.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .filter { f -> f.readLines().any { Regex("\\bOTHER_REALM\\b|\\b[dD]eedOtherRealm\\b|\\botherRealm\\b").containsMatchIn(it.substringBefore("//")) } }
            .map { it.name }.toSortedSet()
        // the constants, the config field and its wiring, the pack check, the deeds-mask and base-state-kind encoders
        assertEquals(sortedSetOf("GroundLoad.kt", "RealmConfig.kt", "RealmEngineWiring.kt", "RealmGrid.kt", "RealmLoader.kt", "WorldEngineConstants.kt"), named)
    }

    /**
     * The rules alone, on stand-alone stages built from the real removed statements (MAP at 205b6326; the FAR chart, the
     * minimap and the stand-in ground at c41c34a9), so this check does not depend on what the exported stages hold.
     */
    @Test fun `each rule catches a mutated stage`() {
        val deed = "if (bs.r == 1u) col = mix(col, vec3(1.0, 0.97, 0.88), 0.5);"
        val removed = "if (bs.r == 2u) col = mix(col, vec3(lum(col)), 0.25) * 0.88;"
        fun map(vararg body: String) = "void main() {\n  ${body.joinToString("\n  ")}\n}\n"
        assertFalse(veilsOtherRealm(map(deed)), "a MAP stage with only the deed line is clean")
        assertTrue(veilsOtherRealm(map(deed, removed)), "the pin-205b6326 veil line put back is caught")
        assertTrue(veilsOtherRealm(map(deed, "if (bs.r==2u) col *= 0.88;")), "any kind-2 read is caught, however it darkens")
        assertTrue(veilsOtherRealm(map(deed, "col = mix(col, vec3(lum(col)), 0.25);")), "the greying is caught without its condition")
        assertFalse(veilsOtherRealm(map(deed, "// $removed", "/* $removed */")), "a veil inside a comment draws nothing and is not flagged")

        // the scanner: each veil removed on 2026-09-26 is caught if it comes back, and a use it cannot read fails loud
        val veils = mapOf(
            "FAR chart" to "void main() { ivec2 cell = ivec2(floor(p)); uint dv = texelFetch(uDeeds, cell, 0).r; if (dv > 80u && dv < 128u) col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), 0.25) * 0.85; }",
            "minimap" to "void main() { uint dv = texelFetch(uDeeds, ivec2(floor(p)), 0).r; if (dv > 80u && dv < 128u) keep *= 0.12; }",
            "stand-in" to "void main() { uint dv = texelFetch(uDeeds, cell, 0).r; if (dv > 80u && dv < 128u) col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), 0.35) * 0.8; if (dv > 200u) col = line; }",
            "MAP" to "void main() { uvec4 bs = texelFetch(uRmBase, d, 0); if (bs.r == 1u) col = line; if (bs.r == 2u) col = mix(col, vec3(lum(col)), 0.25) * 0.88; }",
            "MAP by step" to "void main() { uvec4 bs = texelFetch(uRmBase, d, 0); col *= 1.0 - 0.12 * step(1.5, float(bs.r)); }",
        )
        for ((k, src) in veils) {
            val s = scan(src)
            if (k == "MAP by step") assertEquals(1, s.problems.size, "$k: a step over a converted read fails loud (${s.problems})")
            else assertEquals(1 to emptyList<String>(), s.veils.size to s.problems, "$k: the old veil is caught")
        }
        val clean = scan("void main() { uint dv = texelFetch(uDeeds, cell, 0).r; if (dv > 200u) col = line; uvec4 bs = texelFetch(uRmBase, d, 0); if (bs.r == 1u) col = line; int L = (bs.g & 1u) != 0u ? 1 : 0; }")
        assertEquals(Triple(listOf("uDeeds dv", "uRmBase bs.r"), 2, emptyList<String>()), Triple(clean.reads, clean.branches, clean.veils + clean.problems), "deed lines on this realm's deeds only are clean")
        assertEquals(1, scan("void main() { uint dv = texelFetch(uDeeds, c, 0).r; col *= dv == 96u ? 0.85 : 1.0; }").problems.size, "a ternary veil fails loud")
        assertEquals(1, scan("void main() { col *= texelFetch(uDeeds, c, 0).r == 96u ? 0.85 : 1.0; }").problems.size, "an inline read fails loud")
        assertEquals(1, scan("void main() { uvec4 bs = texelFetch(uRmBase, d, 0); col = tint(bs); }").problems.size, "a whole-vector use fails loud")
        assertEquals(1, scan("void main() { uint dv = texelFetch(uDeeds, c, 0).r; if (dv == uOther) col *= 0.85; }").problems.size, "a condition on a uniform fails loud")
        assertTrue(scan("void main() { uint dv = texelFetch(uDeeds, c, 0).r; if ((dv & 96u) != 0u && dv < 255u) col *= 0.85; }").veils.size == 1, "a bitwise veil is caught")
    }
}
