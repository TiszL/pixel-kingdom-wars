package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.DeedPx
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Kind
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmCatalog
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGrid
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLoader
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmTestData
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmWebPin
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RgbaImage
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.list
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The realm-border deeds where a pack's own deeds.png and the frozen deed catalogue disagree (2–18 per realm), plus the
 * deeds a second foreign-sea cap would move, against the pinned web code (`border.json`, `tools/world-ground-border.mjs`).
 *
 * Why it matters (Rule 7, one source for both clients): GROUND's far field and the deed kinds come from a deeds mask, and
 * the foreign-sea cap moves the coast the classifier reads. The catalogue is server truth (GLOBE-PRODUCTION-PLAN §2.4.3):
 * native reads it (`RealmOpen.deeds`). Stage B (205b6326; rewritten here, was "the cap on the catalogue far field writes
 * the web's coast"): every pack now bakes the cap and the tarn clip into fieldsA.png from the PACK's mask and says so in
 * realm.json, and the unbaked file is not shipped, so no client can rebuild a catalogue coast. Both clients honour the
 * flag and load the baked bytes verbatim, so they class the border identically; the far field stays per mask. A native
 * loader that ignored the flag would cap the coast AGAIN with the catalogue far field and move it on the Seeker only
 * (reRun: 1,508 coast texels and 624 border vertices at the pin) — the teeth below. The residual (the coast is the pack
 * mask's, not the catalogue's) is a web/PACK ask recorded in KNOWN_ISSUES, not hidden here.
 */
class GroundBorderGoldenTest {
    private val plots = RealmTestData.plots
    private val golden: JsonValue by lazy {
        val stream = checkNotNull(javaClass.getResourceAsStream("/world/ground-border/border.json")) {
            "border.json is missing: run node tools/world-ground-border.mjs --source <SHARDKEEP-globe checkout> --pack app/src/main/assets/world"
        }
        JsonReader().parse(stream.use { it.readBytes().toString(Charsets.UTF_8) })
    }
    private val realms: List<JsonValue> get() = list(golden.get("realms"))

    /** The production parser over the catalogue file the APK ships (`native/fantasy/world-v1.json`). */
    private val catalog: RealmCatalog by lazy { RealmCatalog.parse(File("../app/src/main/assets/native/fantasy/world-v1.json").readText()) }

    private fun grid(r: JsonValue): RealmGrid { val g = r.get("grid"); return RealmGrid(g.getInt(0), g.getInt(1), g.getInt(2), g.getInt(3), RealmWebPin.CONFIG.deedDeg) }
    private fun catalogMask(r: JsonValue): ByteArray = catalog.mask(r.getString("realm"), grid(r), DeedPx.THIS_REALM, DeedPx.OTHER_REALM)
    /** The pinned pack's deeds.png (the classify suite of the same pack carries it). */
    private fun packMask(r: JsonValue): ByteArray = GroundGolden.gunzip(GroundGolden.suite("classify-${r.getString("realm")}").getString("deeds"))
    private fun sha256F32(v: FloatArray): String { val b = ByteBuffer.allocate(v.size * 4).order(ByteOrder.LITTLE_ENDIAN); for (f in v) b.putFloat(f); return GroundGolden.sha256(b.array()) }

    /** Held fieldsA texels of [r]'s crops: [x0, y0, w, h] per rect. */
    private fun rects(r: JsonValue): List<IntArray> = list(r.get("fieldsA").get("crops")).map { intArrayOf(it.getInt("x0"), it.getInt("y0"), it.getInt("w"), it.getInt("h")) }

    /** The two realm.json keys ground.js load() reads the baked passes from, as the pack carries them (`fields.fieldsA.baked`,
     *  top-level `fieldsA.baked`; a key the pack lacks is absent). */
    private fun bakedMeta(r: JsonValue): JsonValue {
        fun obj(k: String, v: JsonValue) = JsonValue(JsonValue.ValueType.`object`).also { it.addChild(k, v) }
        fun copy(v: JsonValue) = JsonReader().parse(v.toJson(com.badlogic.gdx.utils.JsonWriter.OutputType.json))
        val m = JsonValue(JsonValue.ValueType.`object`); val f = r.get("fieldsA")
        f.get("bakedFields")?.takeUnless { it.isNull }?.let { m.addChild("fields", obj("fieldsA", obj("baked", copy(it)))) }
        f.get("bakedTop")?.takeUnless { it.isNull }?.let { m.addChild("fieldsA", obj("baked", copy(it))) }
        return m
    }

    private fun far(r: JsonValue, mask: ByteArray): FloatArray = RealmLoader.farDeeds(mask, r.get("grid").getInt(2), r.get("grid").getInt(3), DeedPx.THIS_REALM)

    /**
     * GROUND's load passes on the border crops, native end to end from [mask]: the far field ([RealmLoader.farDeeds], as
     * [GroundLoad.load]), then the production [GroundLoad.fieldPasses] with the pack's own baked flags — which must run no
     * pass (a cap re-run returns stats; the tarn clip would ask for chart8), so the crops stay the file's bytes.
     */
    private fun loadFields(r: JsonValue, mask: ByteArray): FieldImage {
        val cols = r.get("grid").getInt(2); val rows = r.get("grid").getInt(3); val id = r.getString("realm")
        val a = GroundGolden.image(r.get("fieldsA"))
        val passes = GroundLoad.fieldPasses(bakedMeta(r), a, far(r, mask), cols, rows, plots.tiles) { error("$id: the tarn clip asked for chart8 on a baked pack") }
        assertNull(passes.foreignSea, "$id: the foreign-sea cap ran again over PACK's baked coast"); assertNull(passes.tarns, "$id: the tarn clip ran again")
        return a
    }

    /** The teeth: what a loader that ignored the flag would draw — the cap run AGAIN over the baked crops with [mask]'s far field. */
    private fun reRun(r: JsonValue, mask: ByteArray): FieldImage {
        val a = GroundGolden.image(r.get("fieldsA"))
        ClassBake.foreignSea(a, far(r, mask), r.get("grid").getInt(2), r.get("grid").getInt(3), plots.tiles)
        return a
    }

    /** Texels of the crops whose coast (R) / lake (G) differ between [x] and [y], and the deeds holding them (8 px a deed). */
    private fun diff(r: JsonValue, x: FieldImage, y: FieldImage): Triple<Int, Int, List<Int>> {
        val cols = r.get("grid").getInt(2); var dr = 0; var dg = 0; val deeds = sortedSetOf<Int>()
        for (q in rects(r)) for (j in q[1] until q[1] + q[3]) for (i in q[0] until q[0] + q[2]) {
            val a = x.at(i, j, 0) != y.at(i, j, 0); val b = x.at(i, j, 1) != y.at(i, j, 1)
            if (a) dr++; if (b) dg++; if (a || b) deeds += (j / 8) * cols + i / 8
        }
        return Triple(dr, dg, deeds.toList())
    }

    /** Vertices whose (class, ground class, ring, sampled wetness) differ from the web's, on fields [a]; appends to [miss]. */
    private fun classify(r: JsonValue, a: FieldImage, miss: StringBuilder?): IntArray {
        val id = r.getString("realm"); val cols = r.get("grid").getInt(2); val rows = r.get("grid").getInt(3)
        val c = GroundGolden.suite("classify-$id")
        val cls = Classify(plots); val cfg = ClassCfg.from(c.get("classesOverride"))
        val fields = Fields(a, GroundGolden.image(r.get("fieldsBC")), plots.tiles)
        val lines = cls.prepareLines(c.get("lines"), cols, rows, cfg)
        val state = BaseState(cols, rows, ByteArray(cols * rows * 4).also { d -> for (i in 0 until cols * rows) d[i * 4] = 1 }) // classify.js makeState(cols, rows, [])
        state.rivers = cls.bendRivers(lines, state, cfg); state.bridges = cls.plotBridges(fields, lines, state, cfg)
        val d = ClassDetail(); var vertices = 0; var differ = 0
        val border = GroundGolden.ints(r.get("border")); val want = list(r.get("vertices"))
        assertEquals(border.size, want.size, "$id: one vertex set per border deed")
        for ((n, k) in border.withIndex()) for ((band, bc) in listOf("true" to cfg, "lattice" to cfg.lattice())) {
            val w = want[n].get(band); val wc = w.getString("cls"); val wg = w.getString("ground"); val wr = w.getString("ring"); val ww = w.getString("wet")
            for (j in 0 until SIDE) for (i in 0 until SIDE) {
                val v = j * SIDE + i
                val x = ((k % cols) * plots.tiles + OFF + STEP * i).toDouble(); val y = ((k / cols) * plots.tiles + OFF + STEP * j).toDouble()
                cls.classDetail(fields, lines, state, x, y, bc, d)
                val wet = cls.sampledWet(fields, lines, state, x, y, bc)
                if (wc[v].digitToInt(16) != d.cls || wg[v].digitToInt(16) != d.ground || (wr[v] == '1') != d.ring || ww[v].digitToInt() != wet) {
                    differ++
                    if (miss != null && miss.length < 2000) miss.append("$id deed $k $band ($x, $y): web ${wc[v]}/${wg[v]}/${wr[v]}/${ww[v]} native ${d.cls}/${d.ground}/${d.ring}/$wet\n")
                }
                vertices++
            }
        }
        return intArrayOf(vertices, differ)
    }

    @Test fun `the border golden is the border tool's output at the locked pin, over the pack the classify suites use`() {
        val lock = JsonReader().parse(File("../world-shaders.lock.json").readText())
        assertEquals(lock.get("source").getString("commit"), golden.getString("pin"), "a golden from another pin teaches another engine")
        assertEquals(GroundGolden.sha256(File("../tools/world-ground-border.mjs").readBytes()), golden.getString("generator"),
            "tools/world-ground-border.mjs changed since border.json was written: re-run it")
        var pinned = 0
        for (s in list(golden.get("sources"))) lock.get("sources").get(s.name)?.let { assertEquals(it.asString(), s.asString(), "${s.name} is not the pinned module"); pinned++ }
        assertEquals(4, pinned, "classify.js, contracts.js, loader.js and minimap.js are the pinned modules")
        val pack = golden.get("pack").getString("manifestSha256")
        assertEquals(lock.get("contentManifest").getString("sha256"), pack, "the pinned pack")
        for (id in GroundGolden.REALMS) assertEquals(pack, GroundGolden.suite("classify-$id").get("pack").getString("manifestSha256"), "$id: the classify suite is over the same pack")
        assertEquals(GroundGolden.REALMS, realms.map { it.getString("realm") })
        // the web's catalogue is the one the APK ships, byte for byte
        assertEquals(GroundGolden.sha256(File("../app/src/main/assets/native/fantasy/world-v1.json").readBytes()), golden.get("sources").getString("packages/shared/src/data/fantasy-world-v1.json"))
    }

    @Test fun `the catalogue mask GROUND is handed is the web catalogue's, and the pack disagrees on exactly the listed border deeds`() {
        var listed = 0
        for (r in realms) {
            val id = r.getString("realm"); val mask = catalogMask(r); val pack = packMask(r)
            assertContentEquals(GroundGolden.gunzip(r.getString("catalogMask")), mask, "$id: the shipped catalogue parsed by RealmCatalog is the web's fantasyTiles()")
            val want = list(r.get("maskDeeds")).map { Triple(it.getInt(0), it.getInt(1), it.getInt(2)) }
            val got = mask.indices.filter { mask[it] != pack[it] }.map { Triple(it, pack[it].toInt() and 0xff, mask[it].toInt() and 0xff) }
            assertEquals(want, got, "$id: the pack/catalogue disagreement")
            // the Seeker's `mask mismatch` stat (this-realm disagreements) counts the same deeds
            assertEquals(want.count { it.second == DeedPx.THIS_REALM || it.third == DeedPx.THIS_REALM }, RealmCatalog.mismatches(pack, mask, DeedPx.THIS_REALM), "$id mask mismatch")
            listed += want.size
            for (k in GroundGolden.ints(r.get("border"))) assertTrue(k in 0 until mask.size, "$id: border deed $k")
        }
        assertTrue(listed > 0, VOID) // 85 at 205b6326, as at 4de21f1a (NT's deedmask.json lists the same deeds)
    }

    @Test fun `the far field from the catalogue is the web's bit for bit, and the pack's is not`() {
        var packDiffers = 0
        for (r in realms) {
            val id = r.getString("realm"); val cols = r.get("grid").getInt(2); val rows = r.get("grid").getInt(3)
            val far = RealmLoader.farDeeds(catalogMask(r), cols, rows, DeedPx.THIS_REALM)
            assertEquals(r.get("farCatalog").getString("float32Sha256"), sha256F32(far), "$id: far field (float32 bits)")
            assertContentEquals(GroundGolden.gunzip(r.get("farCatalog").getString("r8x16")), RealmLoader.farBytes(catalogMask(r), cols, rows, DeedPx.THIS_REALM), "$id: uFar / uMpFar bytes")
            val packFar = RealmLoader.farDeeds(packMask(r), cols, rows, DeedPx.THIS_REALM)
            val n = far.indices.count { far[it] != packFar[it] }
            assertEquals(r.get("packVsCatalog").getInt("farDeeds"), n, "$id: far-field deeds the pack mask moves")
            packDiffers += n
        }
        assertTrue(packDiffers > 1000, "the pack mask moves only $packDiffers far-field deeds: $VOID") // 1,430 at 205b6326, as at 4de21f1a
    }

    @Test fun `PACK's baked fieldsA loads verbatim with either mask, and a second cap on the catalogue far field would move exactly the web's coast`() {
        var texels = 0L; var teeth = 0
        for (r in realms) {
            val id = r.getString("realm"); val f = r.get("fieldsA")
            // what the pack says it baked, read in ground.js order (fields.fieldsA.baked, else fieldsA.baked)
            assertEquals(list(f.get("baked")).map { it.asString() }, GroundLoad.bakedPasses(bakedMeta(r)).sorted(), "$id: the baked passes")
            assertEquals(listOf("clipTarns", "foreignSea"), list(f.get("baked")).map { it.asString() }, "$id: the pinned pack bakes both passes (the suite would pin the pre-stage-B truth)")
            assertTrue(r.get("foreignSea").getBoolean("baked", false) && r.get("clipTarns").getBoolean("baked", false), "$id: the web ran a pass")
            val file = GroundGolden.image(f); val onCat = loadFields(r, catalogMask(r)); val onPack = loadFields(r, packMask(r))
            // (a) the loaded bytes are the file's, every channel, with either mask: packVsCatalog 0 texels, computed
            val loaded = diff(r, onCat, file); assertEquals(Triple(0, 0, emptyList()), loaded, "$id: the catalogue load changed baked bytes")
            val pvc = diff(r, onCat, onPack); val p = r.get("packVsCatalog")
            assertEquals(Triple(p.getInt("coastTexels"), p.getInt("lakeTexels"), GroundGolden.ints(p.get("fieldDeeds")).toList()), pvc, "$id: what the pack mask moves in the loaded fields")
            var bytes = 0; for (q in rects(r)) for (y in q[1] until q[1] + q[3]) for (x in q[0] until q[0] + q[2]) for (ch in 0 until 4) if (file.at(x, y, ch) != onCat.at(x, y, ch)) bytes++
            assertEquals(0, bytes, "$id: loaded fieldsA bytes (any channel) differ from the file's")
            // (d) the teeth: the cap re-run with the catalogue far field moves exactly the web's texels and deeds; with the pack's
            // far field nothing (the cap is idempotent on its own output — why a re-run is invisible on the web and not here)
            val re = diff(r, reRun(r, catalogMask(r)), file); val w = r.get("reRun")
            assertEquals(Triple(w.getInt("coastTexels"), w.getInt("lakeTexels"), GroundGolden.ints(w.get("fieldDeeds")).toList()), re, "$id: a second cap on the catalogue far field")
            val rp = diff(r, reRun(r, packMask(r)), file)
            assertEquals(w.getInt("packCoastTexels"), rp.first + rp.second, "$id: a second cap on the pack's far field")
            teeth += re.first
            // every texel of every border deed and of its 8 neighbours was compared (the classifier reads < 1 deed away)
            val cols = r.get("grid").getInt(2); val rows = r.get("grid").getInt(3)
            for (k in GroundGolden.ints(r.get("border"))) for (dy in -1..1) for (dx in -1..1) {
                val x = k % cols + dx; val y = k / cols + dy
                if (x in 0 until cols && y in 0 until rows) assertTrue(file.holds(x * 8, y * 8) && file.holds(x * 8 + 7, y * 8 + 7), "$id: deed ($x, $y) around border deed $k is not in the crops")
            }
            for (q in rects(r)) texels += q[2].toLong() * q[3]
        }
        assertTrue(teeth > 0, "a second cap moves no coast texel anywhere: the flag would be unobservable") // 1,508 at 205b6326: crownlands 1,036, sunscar 421, seeker-reach 51
        // (anti-vacuity; the coverage above is the real bound: 47,168 crop texels at 205b6326, whose crops are border deeds
        // ± 1 merged; 59,584 at 4de21f1a)
        assertTrue(texels > 40_000, "only $texels texels compared")
    }

    @Test fun `every border vertex has the web's class, ground class, ring flag and sampled wetness on the loaded fields, and a second cap would break them`() {
        val miss = StringBuilder(); var vertices = 0; var differ = 0; var teeth = 0
        for (r in realms) {
            val id = r.getString("realm")
            val cat = classify(r, loadFields(r, catalogMask(r)), miss)
            vertices += cat[0]; differ += cat[1]
            // the pack mask loads the same bytes: it changes nothing (the web computes packVsCatalog.vertices: 0)
            assertEquals(r.get("packVsCatalog").getInt("vertices"), classify(r, loadFields(r, packMask(r)), null)[1], "$id: border vertices the pack mask changes")
            // teeth: a loader that re-ran the cap with the catalogue far field changes exactly the web's reRun.vertices
            val re = classify(r, reRun(r, catalogMask(r)), null)[1]
            assertEquals(r.get("reRun").getInt("vertices"), re, "$id: border vertices a second cap changes")
            teeth += re
        }
        assertEquals(0, differ, "border vertices differing from the web on the loaded fields ($vertices checked):\n$miss")
        assertEquals(golden.getInt("count"), vertices)
        assertTrue(teeth > 0, "a second cap changes no border vertex: the flag would be unobservable") // 624 at 205b6326: crownlands 572, seeker-reach 52
    }

    @Test fun `GROUND builds its far field, foreign-sea cap and kinds from the mask it is handed, never from the pack's deeds file`() {
        val pack = SyntheticGroundPack()
        val keys = ArrayList<String>()
        val src = object : GroundSource by pack {
            override fun bytes(key: String): ByteArray? { keys += key; return pack.bytes(key) }
            override fun png(key: String): RgbaImage? { keys += key; return pack.png(key) }
        }
        // a catalogue that moves two border deeds of the synthetic realm: one out of it, one into it
        val handed = pack.deeds.copyOf()
        val out = 2 * pack.cols + 2; val into = 1 * pack.cols + 5
        handed[out] = DeedPx.OTHER_REALM.toByte(); handed[into] = DeedPx.THIS_REALM.toByte()
        val a = GroundLoad.load(src, plots, handed, pack.cols, pack.rows)
        assertContentEquals(RealmLoader.farDeeds(handed, pack.cols, pack.rows, DeedPx.THIS_REALM), a.far, "far field of the handed mask")
        assertFalse(RealmLoader.farDeeds(pack.deeds, pack.cols, pack.rows, DeedPx.THIS_REALM).contentEquals(a.far), "the test mask must move the far field")
        assertEquals(Kind.OTHER_REALM, a.state.data[out * 4].toInt()); assertEquals(Kind.OPEN, a.state.data[into * 4].toInt())
        assertFalse(keys.any { it.startsWith("deeds") }, "GROUND read the pack's own mask: $keys")
    }

    private companion object {
        const val SIDE = 14; const val STEP = 7; const val OFF = 3
        /** The teeth: at a pin where no pack differs from the catalogue any more (the web fix landed), rewrite this suite to
         *  pin pack == catalogue instead of letting it pass on nothing. */
        const val VOID = "the pack masks no longer differ from the catalogue where it matters: rewrite this suite to pin pack == catalogue"
    }
}
