package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeGl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBases
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGlRig
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmOpen
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RgbaImage
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LaneUploads
import gg.pixelkingdomwars.nativeclient.renderer.world.ExactPng
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import org.junit.Assume
import org.junit.Test
import java.io.File
import java.lang.ref.WeakReference
import java.lang.reflect.Modifier
import java.util.IdentityHashMap
import java.util.concurrent.Executor
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * P0 memory for GROUND (the Seeker's OutOfMemoryError of 2026-09-26: after nine realm visits the 256 MB Java heap was
 * full, decodes of 5-18 MB failed inside the world-load workers and the host fell back to the legacy globe). Two rules:
 * - a RESIDENT GROUND keeps on the Java heap only what classAt and its draws read (the two field images, the lines, the
 *   base state, the uniform tables and the per-deed bookkeeping): every upload-only array (line words, kit mips, TRUE
 *   arrays, tone and plot art) goes once its fill is queued. Measured by walking everything reachable from the lane;
 * - NOTHING of a released realm stays reachable from the lane: the engine disposes a lane on leave and keeps the object
 *   (the core keeps its restore hook), so a load or base-state job that lands after dispose() must never be kept, and a
 *   load released mid-way stops at its next stage.
 * The real-realm cases read the bundled stage-B packs (app/src/main/assets/world, generated and gitignored); without the
 * bundle they are skipped with a message and the synthetic pack still pins both rules.
 */
class GroundMemoryTest {

    @Test fun `a resident GROUND keeps only the fields, lines, state and tables once its fills are queued`() {
        resident(SyntheticGroundPack(), 4L shl 20)
    }

    @Test fun `a resident Crownlands or Frostveil GROUND holds at most 12 MB on the Java heap`() {
        val bundle = bundleOrSkip()
        for (id in listOf("crownlands", "frostveil")) resident(BundlePack(id, bundle), 12L shl 20)
    }

    /** One realm's resident bytes against its budget: fields + lines + state + [TABLES], and at most [cap] in all. */
    private fun resident(pack: RigPack, cap: Long) {
        val src = TracingPack(pack)
        val g = GroundRig(src)
        g.openAndLoad()
        assertEquals("ready", g.lane.stats.status, "${pack.id}: ${g.lane.stats.error}")
        val st = assertNotNull(g.lane.classState(), "${pack.id}: MAP never became ready")
        val total = Reach.bytes(g.lane, ::notGrounds)
        val fields = src.sizes.getValue("fieldsA.png") + src.sizes.getValue("fieldsBC.png")
        val linesState = Reach.bytes(listOf(st.lines, st.state), ::notGrounds)
        val tables = total - fields - linesState
        println("[ground-mem] ${pack.id} ${pack.cols}x${pack.rows}: resident ${mb(total)} = fields ${mb(fields)} + lines & state ${mb(linesState)} + tables & bookkeeping ${mb(tables)} (cap ${mb(cap)})")
        assertTrue(tables <= TABLES + PER_DEED * pack.cols * pack.rows,
            "${pack.id}: ${mb(tables)} besides the fields, lines and state (budget ${mb(TABLES + PER_DEED * pack.cols * pack.rows)}): an upload-only array stayed resident")
        assertTrue(total <= cap, "${pack.id}: a resident GROUND holds ${mb(total)} on the Java heap (cap ${mb(cap)})")
    }

    @Test fun `a load released before, during or at the end of its decode leaves nothing reachable from the lane`() {
        stale(SyntheticGroundPack())
    }

    @Test fun `a real Crownlands load released before, during or at the end of its decode leaves nothing reachable`() {
        stale(BundlePack("crownlands", bundleOrSkip()))
    }

    private fun stale(pack: RigPack) {
        val baseline = Reach.bytes(GroundRig(pack).lane, ::notGrounds) // a lane that never opened a realm
        // (a) released before the job started: it decodes nothing at all
        run {
            val exec = SwitchExecutor(queue = true); val src = TracingPack(pack); val g = GroundRig(src, exec)
            g.lane.open(g.open); g.lane.dispose(); exec.runQueued()
            assertEquals(emptyList(), src.keys, "${pack.id}: a load released before it started read its pack")
            assertNothingKept(g, src, baseline, "released before the job ran")
        }
        // (b) released while fieldsBC decodes: the stages after it never run
        run {
            val exec = SwitchExecutor(queue = true); lateinit var g: GroundRig
            val src = TracingPack(pack) { if (it == "fieldsBC.png") g.lane.dispose() }
            g = GroundRig(src, exec)
            g.lane.open(g.open); exec.runQueued()
            assertEquals(listOf("realm.json", "fieldsA.png", "fieldsBC.png"), src.keys, "${pack.id}: a released load kept decoding and baking")
            assertNothingKept(g, src, baseline, "released mid-load")
        }
        // (c) released during the last decode (no stage boundary after it): the finished load is not published
        run {
            val exec = SwitchExecutor(queue = true); lateinit var g: GroundRig
            val last = "decals.png"
            val src = TracingPack(pack) { if (it == last) g.lane.dispose() }
            g = GroundRig(src, exec)
            g.lane.open(g.open); exec.runQueued()
            assertEquals(last, src.keys.last(), "${pack.id}: the test needs $last to be the load's last read")
            assertNothingKept(g, src, baseline, "released during the last decode")
        }
    }

    @Test fun `a base-state job that lands after dispose() is never kept`() {
        val exec = SwitchExecutor(queue = false)
        val g = GroundRig(executor = exec)
        val baseline = Reach.bytes(GroundRig().lane, ::notGrounds)
        g.openAndLoad()
        g.look(33.0, 20.0, 150.0, 0.0, 0.0)
        var n = 0; while (!g.lane.mapReady(g.view) && n++ < 200) g.frame()
        exec.queue = true
        // the synthetic river runs through deed (33, 20): a kingdom there starts a base-state job on the worker
        g.bases.set(WorldBases(2L, "crownlands", intArrayOf(33), intArrayOf(20), intArrayOf(10), intArrayOf(0)))
        g.lane.basesChanged(g.bases)
        assertEquals(1, exec.queued.size, "the base-state job waits on the worker")
        g.lane.dispose()
        exec.runQueued()
        val kept = Reach.bytes(g.lane, ::notGrounds)
        assertTrue(kept <= baseline + SLACK, "a base-state job that landed after dispose() is kept: ${kept - baseline} B over a fresh lane")
        g.frame()
        assertEquals(0, g.lane.stats.baseJobs, "a released job was adopted")
    }

    private fun assertNothingKept(g: GroundRig, src: TracingPack, baseline: Long, what: String) {
        val kept = Reach.bytes(g.lane, ::notGrounds)
        println("[ground-mem] ${g.pack.id} $what: the lane holds $kept B (a fresh lane $baseline B)")
        assertTrue(kept <= baseline + SLACK, "${g.pack.id} $what: the lane still holds ${kept - baseline} B of the released realm")
        assertEquals("none", g.lane.stats.status, "${g.pack.id} $what")
        assertTrue(gcCleared(src.decoded), "${g.pack.id} $what: ${src.decoded.count { it.get() != null }} decoded arrays are still reachable")
    }

    private fun gcCleared(refs: List<WeakReference<ByteArray>>): Boolean {
        repeat(10) { System.gc(); if (refs.all { it.get() == null }) return true; Thread.sleep(20) }
        return false
    }

    private fun bundleOrSkip(): File {
        val root = File("../app/src/main/assets/world/realm")
        if (!File(root, "crownlands/realm.json").isFile) println("[ground-mem] SKIPPED real-realm cases: no bundled stage-B packs at ${root.absolutePath}")
        Assume.assumeTrue("the bundled stage-B packs are not generated at ${root.absolutePath}", File(root, "crownlands/realm.json").isFile)
        return root
    }

    private fun mb(b: Long) = "%.2f MB".format(b / 1048576.0)

    private companion object {
        /** Besides fields, lines and state: realm.json's tree, the uniform tables and the lane's fixed scratch (+ [PER_DEED]
         *  for the per-deed bookkeeping: the base copies and upload buffer, line page maps, the page table mirror, far field). */
        const val TABLES = 1L shl 20
        const val PER_DEED = 48L
        /** What a released lane may hold over a fresh one (its plan arrays grow with the views it has drawn). */
        const val SLACK = 4096L
    }
}

/** Not GROUND's: the core, the uploader, the uniform sink, the engine's realm and bases, GL handles and programs, the pack
 *  source, executors and host-supplied lambdas, and the test rig. The walk stops there. */
internal fun notGrounds(o: Any): Boolean = o is Gl3Core || o is LaneUploads || o is GroundUniformSink || o is RealmOpen || o is RealmBases ||
    o is Gl3Texture || o is Gl3Program || o is GroundSource || o is Executor || o is Function<*> || o is RealmGlRig || o is FakeGl3 || o is GroundRig

/**
 * Bytes of every primitive array (and direct buffer: on ART these are Java-heap arrays too) reachable from a root through
 * object fields, arrays, collections and maps, stopping at [stop]. JDK internals are walked only through their public
 * collection/map/buffer views (strong encapsulation); a String counts its length.
 */
internal object Reach {
    fun bytes(root: Any, stop: (Any) -> Boolean): Long {
        val seen = IdentityHashMap<Any, Boolean>()
        val todo = ArrayDeque<Any>(); todo.add(root)
        var total = 0L
        while (todo.isNotEmpty()) {
            val o = todo.removeLast()
            if (seen.put(o, true) != null || (o !== root && stop(o))) continue
            when (o) {
                is ByteArray -> total += o.size
                is BooleanArray -> total += o.size
                is ShortArray -> total += 2L * o.size
                is CharArray -> total += 2L * o.size
                is IntArray -> total += 4L * o.size
                is FloatArray -> total += 4L * o.size
                is LongArray -> total += 8L * o.size
                is DoubleArray -> total += 8L * o.size
                is Array<*> -> for (e in o) if (e != null) todo.add(e)
                is String -> total += o.length
                is java.nio.Buffer -> if (o.hasArray()) todo.add(o.array()) else if (o.isDirect) total += o.capacity().toLong()
                is Map<*, *> -> for ((k, v) in o) { if (k != null) todo.add(k); if (v != null) todo.add(v) }
                is Collection<*> -> for (e in o) if (e != null) todo.add(e)
                else -> fields(o, todo)
            }
        }
        return total
    }

    private fun fields(o: Any, todo: ArrayDeque<Any>) {
        var c: Class<*>? = o.javaClass
        while (c != null && !jdk(c)) {
            for (f in c.declaredFields) {
                if (Modifier.isStatic(f.modifiers) || f.type.isPrimitive) continue
                val v = try { f.isAccessible = true; f.get(o) } catch (e: RuntimeException) { null } ?: continue
                todo.add(v)
            }
            c = c.superclass
        }
    }

    private fun jdk(c: Class<*>) = c.name.let { n -> n.startsWith("java.") || n.startsWith("javax.") || n.startsWith("jdk.") || n.startsWith("sun.") || n.startsWith("com.sun.") }
}

/** Runs tasks at once, or queues them while [queue] (a worker that has not got to them yet). */
internal class SwitchExecutor(var queue: Boolean) : Executor {
    val queued = ArrayList<Runnable>()
    override fun execute(command: Runnable) { if (queue) queued += command else command.run() }
    fun runQueued() { val q = ArrayList(queued); queued.clear(); q.forEach { it.run() } }
}

/** A pack that records what the load reads, weak references to every decoded image and their sizes; [onRead] runs before
 *  each read (a test's dispose "on the GL thread" at that moment). */
internal class TracingPack(private val inner: RigPack, private val onRead: (String) -> Unit = {}) : RigPack by inner {
    val keys = ArrayList<String>()
    val decoded = ArrayList<WeakReference<ByteArray>>()
    val sizes = HashMap<String, Long>()
    override fun realmJson(): JsonValue { keys += "realm.json"; onRead("realm.json"); return inner.realmJson() }
    override fun bytes(key: String): ByteArray? { keys += key; onRead(key); return inner.bytes(key) }
    override fun png(key: String): RgbaImage? { keys += key; onRead(key); return inner.png(key)?.also { trace(key, it) } }
    override fun image(bytes: ByteArray, key: String): RgbaImage? = inner.image(bytes, key)?.also { trace(key, it) }
    private fun trace(key: String, img: RgbaImage) { decoded += WeakReference(img.rgba); sizes[key] = img.rgba.size.toLong() }
}

/**
 * A bundled stage-B realm pack (app/src/main/assets/world/realm/<id>): realm.json, lines.json and the data PNGs as shipped
 * (decoded exactly by [ExactPng], as on the device), the deeds mask's R channel (RealmLoader's), and each WebP (chart8,
 * tone, plots: the JVM has no WebP decoder) as an image of that file's own size, so every array is the device's size.
 */
internal class BundlePack(override val id: String, root: File) : RigPack {
    private val dir = File(root, id)
    private val grid = JsonReader().parse(File(dir, "realm.json").readText()).get("grid")
    override val cols = grid.getInt("cols")
    override val rows = grid.getInt("rows")
    override val deeds: ByteArray = assertNotNull(ExactPng.decode(File(dir, "deeds.png").readBytes())).let { p -> ByteArray(cols * rows) { p.rgba[it * 4] } }
    override fun realmJson(): JsonValue = JsonReader().parse(File(dir, "realm.json").readText())
    override fun bytes(key: String): ByteArray? = File(dir, key).takeIf { it.isFile }?.readBytes()
    override fun image(bytes: ByteArray, key: String): RgbaImage? =
        webpSize(bytes)?.let { (w, h) -> RgbaImage(w, h, ByteArray(w * h * 4) { i -> if (i % 4 == 3) -1 else ((i / 4) % 251).toByte() }) }

    private fun webpSize(b: ByteArray): Pair<Int, Int>? {
        if (b.size < 30 || String(b, 0, 4, Charsets.US_ASCII) != "RIFF" || String(b, 8, 4, Charsets.US_ASCII) != "WEBP") return null
        fun u(i: Int) = b[i].toInt() and 0xff
        return when (String(b, 12, 4, Charsets.US_ASCII)) {
            "VP8X" -> (1 + (u(24) or (u(25) shl 8) or (u(26) shl 16))) to (1 + (u(27) or (u(28) shl 8) or (u(29) shl 16)))
            "VP8L" -> (u(21) or (u(22) shl 8) or (u(23) shl 16) or (u(24) shl 24)).let { ((it and 0x3fff) + 1) to (((it ushr 14) and 0x3fff) + 1) }
            "VP8 " -> ((u(26) or (u(27) shl 8)) and 0x3fff) to ((u(28) or (u(29) shl 8)) and 0x3fff)
            else -> null
        }
    }
}
