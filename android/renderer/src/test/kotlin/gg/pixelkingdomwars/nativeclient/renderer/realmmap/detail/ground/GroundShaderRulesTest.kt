package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Classes
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GpuSafe
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldShaders
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.list
import org.junit.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * GROUND's GPU safety rules on the EXPORTED stages the native engine compiles (`WorldShaders`, the pin's own
 * preprocessGLSL output: includes resolved, defines inserted), not on the web sources: every loop has a literal trip
 * count ≤ 16 and no `while`/`do`, the classifier is reached only by the `rm-raw` bake (once per vertex) and by no display
 * or `classes`-reading program (LIFE, BASES), the loop iterations per fragment equal groundcost.js `ITERS` walked from
 * `main()`, and every fetch call site is the cost model's. Why it matters: a data-driven loop or a classifier inlined into
 * a per-pixel program is what hung the owner's GPU (RM-GPU-1); a native port that compiled different strings would lose
 * every web guard, so the guard runs again here on the bytes that ship. Each rule is proven to bite on a mutated stage.
 */
class GroundShaderRulesTest {
    private val manifest: JsonValue = JsonReader().parse(File("../tools/world-shaders-ground.json").readText())
    private val programs = list(manifest.get("programs"))
    private val exported = programs.filter { it.getBoolean("exported") }
    private val cost = GroundGolden.suite("groundcost").get("constants")

    private fun stage(key: String): String {
        val p = WorldShaders.realm[key] ?: fail("ground program $key is not exported")
        return WorldShaders.source(p.fs)
    }

    // ---------------------------------------------------------------- GLSL reading (ports of the web groundcost.test walkers)

    private val fetchFn = Regex("^(texelFetch|texelFetchOffset|texture|textureOffset|textureLod|textureLodOffset|textureGrad|textureGradOffset|textureProj|textureProjLod)$")
    private val fetchCall = Regex("\\b(texelFetch|texelFetchOffset|texture|textureOffset|textureLod|textureLodOffset|textureGrad|textureGradOffset|textureProj|textureProjLod)\\s*\\(")
    private val keywords = setOf("if", "for", "while", "else", "return", "switch")

    private fun stripComments(s: String) = s.replace(Regex("/\\*[\\s\\S]*?\\*/"), " ").replace(Regex("//[^\\n]*"), "")

    /** groundcost.test `fnTable`: name → bodies (overloads kept), comments stripped. */
    fun fnTable(src: String): Map<String, List<String>> {
        val s = stripComments(src); val out = LinkedHashMap<String, MutableList<String>>()
        val re = Regex("\\b[A-Za-z_]\\w*\\s+([A-Za-z_]\\w*)\\s*\\(([^()]*)\\)\\s*\\{")
        var from = 0
        while (true) {
            val m = re.find(s, from) ?: break
            val name = m.groupValues[1]
            if (name in keywords) { from = m.range.last + 1; continue }
            var i = m.range.last + 1; var d = 1
            while (d > 0 && i < s.length) { if (s[i] == '{') d++ else if (s[i] == '}') d--; i++ }
            out.getOrPut(name) { ArrayList() }.add(s.substring(m.range.last + 1, i - 1))
            from = i
        }
        return out
    }

    private fun skipWs(s: String, i0: Int): Int { var i = i0; while (i < s.length && s[i].isWhitespace()) i++; return i }
    private fun closeParen(s: String, i0: Int): Int { var d = 0; var i = i0; while (i < s.length) { if (s[i] == '(') d++ else if (s[i] == ')') { d--; if (d == 0) return i + 1 }; i++ }; return i }
    private fun stmtEnd(s: String, i0: Int): Int {
        var i = skipWs(s, i0)
        if (i < s.length && s[i] == '{') { var d = 0; while (i < s.length) { if (s[i] == '{') d++ else if (s[i] == '}') { d--; if (d == 0) return i + 1 }; i++ }; return i }
        val kw = Regex("^(for|while|if)\\b").find(s.substring(i))
        if (kw != null) {
            var j = stmtEnd(s, closeParen(s, i + kw.value.length))
            if (kw.value == "if") { val k = skipWs(s, j); if (Regex("^else\\b").containsMatchIn(s.substring(k))) j = stmtEnd(s, k + 4) }
            return j
        }
        var d = 0
        while (i < s.length) { val c = s[i]; if (c == '(' || c == '[') d++ else if (c == ')' || c == ']') d-- else if (c == ';' && d == 0) return i + 1; i++ }
        return i
    }

    class Walk(val iters: Long, val fetches: Long, val calls: Map<String, Long>)

    /** groundcost.test `walk(src)`: from main(), every call and loop counted once per enclosing trip, both branch arms. */
    fun walk(src: String): Walk {
        val fns = fnTable(src); val memo = HashMap<String, Walk>()
        fun cost(name: String): Walk {
            memo[name]?.let { return it }
            memo[name] = Walk(0, 0, emptyMap()) // (recursion guard; GLSL has none)
            var best = Walk(0, 0, emptyMap())
            for (b in fns.getValue(name)) {
                class Loop(val at: Int, val from: Int, val to: Int, val trip: Long)
                val loops = Regex("\\bfor\\s*\\(([^;]*);([^;]*);([^)]*)\\)").findAll(b).map { m ->
                    val init = Regex("=\\s*(-?\\d+)\\s*$").find(m.groupValues[1]); val cond = Regex("^\\w+\\s*(<=|<)\\s*(-?\\d+)$").find(m.groupValues[2].trim())
                        ?: fail("$name: loop \"${m.value}\" has no literal bound")
                    val trip = cond.groupValues[2].toLong() - (init?.groupValues?.get(1)?.toLong() ?: 0L) + (if (cond.groupValues[1] == "<=") 1 else 0)
                    Loop(m.range.first, m.range.last + 1, stmtEnd(b, closeParen(b, m.range.first + 3)), trip)
                }.toList()
                fun mult(p: Int): Long { var k = 1L; for (l in loops) if (p >= l.from && p < l.to) k *= l.trip; return k }
                var iters = 0L; var fetches = 0L; val calls = HashMap<String, Long>()
                for (l in loops) iters += l.trip * mult(l.at)
                for (m in Regex("\\b([A-Za-z_]\\w*)\\s*\\(").findAll(b)) {
                    val n = m.groupValues[1]; val k = mult(m.range.first)
                    if (fetchFn.matches(n)) { fetches += k; continue }
                    if (!fns.containsKey(n) || n == name) continue
                    val c = cost(n); iters += c.iters * k; fetches += c.fetches * k
                    calls[n] = (calls[n] ?: 0L) + k
                    for ((x, v) in c.calls) calls[x] = (calls[x] ?: 0L) + v * k
                }
                if (iters + fetches > best.iters + best.fetches) best = Walk(iters, fetches, calls)
            }
            memo[name] = best
            return best
        }
        assertTrue(fns.containsKey("main"), "a program has main()")
        return cost("main")
    }

    /** The web's loop rule: literal bound, `v++` step, a literal or `int b = a + k` start; trips ≤ [max]. */
    fun loopViolations(src: String, max: Int = 16): List<String> {
        val code = stripComments(src); val out = ArrayList<String>()
        if (Regex("\\bwhile\\s*\\(").containsMatchIn(code)) out += "while loop"
        if (Regex("\\bdo\\s*\\{").containsMatchIn(code)) out += "do loop"
        for (m in Regex("\\bfor\\s*\\(([^;]*);([^;]*);([^)]*)\\)").findAll(code)) {
            val init = Regex("=\\s*(-?\\d+)\\s*$").find(m.groupValues[1]); val cond = Regex("^\\w+\\s*(<=|<)\\s*(-?\\d+)$").find(m.groupValues[2].trim()); val step = m.groupValues[3].trim()
            if (!m.groupValues[1].contains('=') || cond == null || !Regex("^\\w+\\+\\+$").matches(step)) { out += "\"${m.value}\" has no literal bound"; continue }
            if (init == null && !Regex("^\\s*int\\s+\\w+\\s*=\\s*\\w+\\s*\\+\\s*\\d+\\s*$").matches(m.groupValues[1])) { out += "\"${m.value}\" starts at an unbounded value"; continue }
            val n = cond.groupValues[2].toInt() - (init?.groupValues?.get(1)?.toInt() ?: 0) + (if (cond.groupValues[1] == "<=") 1 else 0)
            if (n < 0 || n > max) out += "\"${m.value}\" runs $n times"
        }
        return out
    }

    /** Fetch call sites per function body (groundcost.test `sitesOf`), first definition per name. */
    fun sites(src: String): Map<String, Int> = fnTable(src).mapValues { (_, bodies) -> fetchCall.findAll(bodies[0]).count() }

    // ---------------------------------------------------------------- the rules

    @Test fun `every listed ground program is exported, Cinderfall's lava variant included, and matches the pin`() {
        // Rewritten when NT exported the lava variant (was: "exported but for the named pending variant"). The exporter now
        // reads this list and exports rm-map+RM_LAVA after checking that ground.js sets gd.RM_LAVA; a Cinderfall drawn with
        // the lava-free rm-map would show plain water where the web shows lava.
        assertEquals(WorldShaders.PIN, manifest.getString("pin"), "world-shaders-ground.json names another pin")
        assertEquals(emptyList(), programs.filter { !it.getBoolean("exported") }.map { it.getString("key") }, "every listed program is in the export")
        for (p in programs) assertTrue(WorldShaders.realm.containsKey(p.getString("key")), "${p.getString("key")} is missing from WorldShaders")
        // the variant is the same MAP_FS with the lava branch compiled in, and only the variant compiles it
        val define = Regex("^#define RM_LAVA[ \\t]*$", RegexOption.MULTILINE)
        assertTrue(define.containsMatchIn(stage(GroundPrograms.MAP_LAVA)), "rm-map+RM_LAVA defines RM_LAVA")
        assertTrue(!define.containsMatchIn(stage(GroundPrograms.MAP)), "rm-map (every other realm) compiles no lava branch")
        assertEquals(stage(GroundPrograms.MAP).replace(define, ""), stage(GroundPrograms.MAP_LAVA).replace(define, ""), "the variant differs by the define alone")
    }

    @Test fun `every ground stage has literal-bounded loops of at most 16 trips and no while or do`() {
        var loops = 0
        for (p in exported) {
            val fs = stage(p.getString("key"))
            assertEquals(emptyList(), loopViolations(fs), "${p.getString("key")} (exported FS)")
            loops += Regex("\\bfor\\s*\\(").findAll(stripComments(fs)).count()
            assertEquals(emptyList(), loopViolations(WorldShaders.source(WorldShaders.realm.getValue(p.getString("key")).vs)), "${p.getString("key")} (exported VS)")
        }
        assertTrue(loops >= 40, "only $loops loops seen in the ground stages")
        // teeth: a data-driven bound, a 17-trip loop and a while loop are each refused
        assertTrue(loopViolations("void main() { for (int k = 0; k < uCount; k++) { } }").isNotEmpty(), "a data-driven bound passes")
        assertTrue(loopViolations("void main() { for (int k = 0; k < 17; k++) { } }").isNotEmpty(), "a 17-trip loop passes")
        assertTrue(loopViolations("void main() { int k = 0; while (k < 4) k++; }").isNotEmpty(), "a while loop passes")
    }

    @Test fun `the classifier is reached only by rm-raw, once per vertex - never by a display program or a classes reader`() {
        val rules = fnTable(stage("rm-raw")).keys.filter { it.startsWith("rmClass") || it == "rmStroke" || it.startsWith("rmBC") || it == "rmParcel" }
        assertTrue("rmClassCore" in rules && rules.size >= 4, "rm-classify's functions are in rm-raw ($rules)")
        for (p in exported) {
            val key = p.getString("key"); val w = walk(stage(key))
            if (key == "rm-raw") assertEquals(1L, w.calls["rmClassCore"], "the raw resolve runs the classifier exactly once per vertex")
            else assertEquals(emptyList(), w.calls.keys.filter { it == "rmClassCore" }, "$key reaches the classifier")
        }
        // every other realm program (LIFE, BASES, minimap, the overview): no classifier function defined at all
        var others = 0
        for ((key, p) in WorldShaders.realm) {
            if (key.startsWith("rm-")) continue
            for (st in listOf(p.vs, p.fs)) assertTrue("rmClassCore" !in fnTable(WorldShaders.source(st)), "$key carries the classifier")
            others++
        }
        assertTrue(others >= 12, "only $others non-ground programs checked")
        // teeth: two wrapped classifier reads are two inlined copies
        val raw = stage("rm-raw")
        val bad = raw.replace(Regex("void main\\(\\)\\s*\\{"), "uint rhWrap(ivec2 v) { float c, w; return rmClassAt(v, c, w); }\nvoid main() { uint rhA = rhWrap(ivec2(1)) + rhWrap(ivec2(2));")
        if (fnTable(bad).containsKey("rmClassAt")) assertTrue((walk(bad).calls["rmClassCore"] ?: 0L) >= 2L, "the walk no longer sees wrapped classifier copies")
    }

    /**
     * RM-23 (web fix pass, shader-only; classes.glsl rmLatTexel): a lattice read outside the realm grid is the open sea —
     * DEEP (class 0 + 1, no flags) once a lattice exists, 0 (unresolved) before one exists — never the unresolved WILD that
     * seated LIFE's scrub and rocks in one row just past every grid edge. Native has no CPU mirror of mapClassAt and sets
     * uRmLat.z = 0 while it has no lattice (GroundLane.bindClassUnits), so the rule lives in the shipped stages alone: pinned
     * on every exported stage that reads the lattice, and proven to bite on the pre-RM-23 body.
     */
    @Test fun `every lattice reader returns DEEP outside the realm grid once a lattice exists, unresolved before one does (RM-23)`() {
        val rule = Regex("if\\s*\\(\\s*l\\.x\\s*<\\s*0\\s*\\|\\|\\s*l\\.y\\s*<\\s*0\\s*\\|\\|\\s*l\\.x\\s*>=\\s*uRmLat\\.z\\s*\\|\\|\\s*l\\.y\\s*>=\\s*uRmLat\\.w\\s*\\)\\s*" +
            "return\\s+uRmLat\\.z\\s*>\\s*0\\s*\\?\\s*1u\\s*:\\s*0u\\s*;")
        fun follows(src: String): Boolean? = fnTable(src)["rmLatTexel"]?.all { rule.containsMatchIn(it) }
        assertEquals(0, Classes.DEEP, "1u encodes DEEP (lattice texel = class + 1)")
        val readers = ArrayList<String>()
        for ((key, p) in WorldShaders.realm) for ((st, src) in listOf("vs" to WorldShaders.source(p.vs), "fs" to WorldShaders.source(p.fs))) {
            val ok = follows(src) ?: continue
            assertTrue(ok, "$key $st: rmLatTexel's out-of-grid read is not RM-23's (DEEP once a lattice exists)")
            readers += "$key $st"
        }
        assertTrue(readers.size >= 6, "only ${readers.size} lattice readers checked: $readers") // the six LIFE vertex stages at 205b6326
        // teeth: the pre-RM-23 body (WILD, i.e. unresolved, outside the grid) is refused
        val old = "uint rmLatTexel(ivec2 v) {\n  ivec2 l = ivec2(floor(vec2(v) / 7.0 + 0.5));\n  if (l.x < 0 || l.y < 0 || l.x >= uRmLat.z || l.y >= uRmLat.w) return 0u;\n" +
            "  ivec2 pg = l / uRmLat.x;\n  return texelFetch(uRmLattice, ivec3(l - pg * uRmLat.x, pg.y * uRmLat.y + pg.x), 0).r;\n}\nvoid main() {}\n"
        assertFalse(follows(old)!!, "the pre-RM-23 body passes")
    }

    @Test fun `loop iterations per fragment walked from main on the exported stages equal groundcost js ITERS`() {
        val iters = cost.get("ITERS")
        for (p in exported) {
            val key = p.getString("key"); val pass = p.getString("pass")
            assertEquals(iters.getLong(pass), walk(stage(key)).iters, "$key: loop iterations per fragment (ITERS.$pass)")
        }
        // teeth: one more 9-trip loop in rm-map's main moves the walk
        val map = stage("rm-map")
        val more = map.replace(Regex("void main\\(\\)\\s*\\{"), "void main() { float rhT = 0.0; for (int k = 0; k < 9; k++) rhT += 1.0;")
        assertEquals(iters.getLong("map") + 9, walk(more).iters, "the walk missed an added loop")
    }

    @Test fun `every fetch call site in the ground stages is one groundcost js counts`() {
        val table = HashMap<String, Int>() // function → sites, from SITES (every GROUND function with a fetch; main per program)
        val mainOf = HashMap<String, Int>()
        for (group in list(cost.get("SITES"))) for (f in list(group)) {
            if (f.name == "main") mainOf[group.name] = f.asInt() else { val prev = table.put(f.name, f.asInt()); assertTrue(prev == null || prev == f.asInt(), "${f.name} counted twice") }
        }
        val srcOf = mapOf("rm-despeckle" to "resolve:DESPECKLE_FS", "rm-legalise" to "resolve:LEGALISE_FS", "rm-record" to "resolve:RECORD_FS", "rm-pure" to "resolve:PURE_FS",
            "rm-chart" to "chart:CHART_FS", "rm-map" to "mapground:MAP_FS", "rm-map+RM_LAVA" to "mapground:MAP_FS", "rm-true" to "trueground:TRUE_FS", "rm-raw" to "resolve:RAW_FS")
        var checked = 0
        for (p in exported.filter { !it.has("qa") }) {
            val key = p.getString("key"); val s = sites(stage(key))
            for ((fn, n) in s) {
                if (fn == "main") { assertEquals(mainOf[srcOf.getValue(key)] ?: 0, n, "$key main()"); checked++; continue }
                val want = table[fn]
                if (want != null) { assertEquals(want, n, "$key: $fn"); checked++ }
                else if (n > 0 && fn.startsWith("rm")) fail("$key: $fn has $n fetch call site(s) the cost model does not count")
            }
        }
        assertTrue(checked >= 20, "only $checked function bodies checked")
        // teeth: one more texelFetch in a counted function is seen
        val chart = stage("rm-chart")
        val extra = chart.replace("float coastAt(vec2 p) {", "float coastAt(vec2 p) { float rhX = texelFetch(uFieldsA, ivec2(0), 0).r;")
        assertEquals((table["coastAt"] ?: 0) + 1, sites(extra)["coastAt"], "a new fetch site went unseen")
    }

    @Test fun `every ground stage fits the shader size caps`() {
        val index = JsonReader().parse(GroundShaderRulesTest::class.java.getResourceAsStream("/world/shaders/index.json")!!.use { it.readBytes().toString(Charsets.UTF_8) })
        val byName = list(index.get("programs")).associateBy { it.getString("name") + list(it.get("defines")).joinToString("") { d -> "+" + d.name + (if (d.isBoolean) "" else "=" + d.asString()) } }
        for (p in exported) {
            val key = p.getString("key")
            val e = byName[key] ?: fail("$key is not in index.json")
            val fs = e.get("fs")
            assertTrue(fs.getInt("chars") <= GpuSafe.SHADER_STAGE_CHARS, "$key FS ${fs.getInt("chars")} chars")
            assertTrue(fs.getInt("inlinedChars") <= GpuSafe.SHADER_INLINED_CHARS, "$key inlined main ${fs.getInt("inlinedChars")} chars")
        }
    }
}
