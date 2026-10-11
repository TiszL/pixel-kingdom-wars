package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldShaders
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLoader
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPackFiles
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.GoldenKit.children
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * LIFE's species table against the pinned web engine (tools/world-lifebases.mjs `golden-table.json`: life.js `load()` over
 * the pinned pack, its RGBA16UI upload hashed texel for texel), and the two GPU premises stage B leans on. Why it matters:
 * every LIFE vertex reads this table (species, layers, twins and, since stage B, a map object's lens glow), so a packing
 * drift draws a different sprite, layer or glow than the web on the same tile while every compile and placement golden
 * stays green; and the shader's species search and its eight group slots are literals the tables must stay inside.
 */
class LifeTableGoldenTest {
    private val file = LifeTablesFile.load()
    private val c = file.constants
    private val cat = GoldenKit.catalogue()
    private val geo = LifeGeometry(cat.get("GRID").getInt("tilePx"), cat.get("BASE_GROUND_WORLD_GEOMETRY").getInt("worldTiles"), c.pinnedMapArt)
    private val sc = Scatter(c, geo)
    private val golden = GoldenKit.json(LifeTableGoldenTest::class.java, "golden-table.json")
    private val compile = GoldenKit.json(LifeTableGoldenTest::class.java, "golden-compile.json")

    @Test fun theGoldenCoversEveryRealmAtTheTableWidthTheLoaderWrites() {
        assertEquals("tables and golden come from one pin", golden.getString("pin"), file.pin)
        assertEquals(file.tables.keys, children(golden.get("realms")).map { it.name }.toSet())
        // stage B: MAX_SPECIES 64 × SPT 6 texels (was 32 × 6); the loader sizes its rows from the same constants
        for (r in children(golden.get("realms"))) assertEquals("${r.name} tableW", c.maxSpecies * c.spt, r.getInt("tableW"))
    }

    /**
     * The real Solana Reach pack (the pinned pack's bytes, committed as a test fixture: the only realm with lens glows, and a
     * stage-B realm) through [LifeLoad.build]: the whole table, its group flags, the beacons' glow rows, the missing list,
     * the dark twins it replaced and its texture arrays equal life.js's, exactly.
     */
    @Test fun lifeLoadBuildsSolanaReachsTableTexelForTexelAsTheWebDoes() {
        val want = golden.get("realms").get(SOLANA)
        val got = project(build(FixturePack.classpath(), SOLANA), c.spt)
        for (k in KEYS) assertEquals("$SOLANA $k", Deep.json(want.get(k)), Deep.kotlin(got[k]))
        // the golden must hold the thing it pins: both beacons' lenses glow, in the map-object group
        assertEquals(listOf("map_beacon_1", "map_beacon_2"), children(want.get("glow")).map { it.getString(3) })
    }

    /**
     * The GPU picks a species by a lower-bound search of the non-decreasing `cum − 1` column, in the literal trip count
     * the exported SCATTER_VS carries (stage B: 7); the CPU (and every placement golden) scans linearly. The two agree only
     * while 2^trips > MAX_SPECIES; a 64-species row under a shorter search would place another tree on the GPU than the
     * goldens pin. Every group of every realm (golden stubs: the pack's sprites), at every cum boundary.
     */
    @Test fun theGpusLowerBoundSpeciesPickIsTheCpuScansPickInEveryGroup() {
        val src = WorldShaders.source(WorldShaders.realm.getValue(LifeLane.K_SCATTER).vs)
        val trips = Regex("""int pickSpecies\(int row, int n, uint pick\) \{\s*int lo = 0, hi = n;\s*for \(int i = 0; i < (\d+); i\+\+\)""").find(src)
            ?.groupValues?.get(1)?.toInt() ?: error("the exported SCATTER_VS has no lower-bound pickSpecies")
        assertTrue("2^$trips trips cover MAX_SPECIES ${c.maxSpecies}", (1 shl trips) > c.maxSpecies)
        var picks = 0; var widest = 0; var groups = 0
        for (realm in file.tables.keys) for (g in compiled(realm).groups) {
            val sp = g.species; widest = Math.max(widest, sp.size); groups++
            val probes = LinkedHashSet<Int>(); probes += 0; probes += 65535
            for (s in sp) { probes += s.cum - 1; probes += Math.min(65535, s.cum) }
            for (p in 0 until 65536 step 997) probes += p
            for (p in probes) { assertEquals("$realm/${g.id} pick $p", sc.pickSpecies(sp, p), gpuPick(sp, p, trips)); picks++ }
        }
        assertTrue("Solana Reach's 53 map objects are in the search ($widest)", widest > 32)
        assertTrue("every realm's groups were searched ($groups)", groups >= 8 * 8)
        assertTrue("every group was probed at its boundaries and a sweep ($picks picks)", picks > groups * 66)
    }

    /** SCATTER_VS's pickSpecies over `cum − 1` (sprites.glsl.js, stage B), trip-bounded like the shader. */
    private fun gpuPick(sp: Array<CSpecies>, pick: Int, trips: Int): Int {
        var lo = 0; var hi = sp.size
        for (i in 0 until trips) { if (lo >= hi) break; val mid = (lo + hi) shr 1; if (pick <= sp[mid].cum - 1) hi = mid else lo = mid + 1 }
        return if (lo < sp.size) lo else -1
    }

    /**
     * One scatter draw binds one texture array and carries at most `uGrp[8]` groups (LifeLane.drawScatter stops at the
     * eighth owner, as life.js does): a ninth group owning species in one array would silently not draw on either client.
     * Kit art is owned by the non-map-only groups, twins by the twin groups, puffs by the emitter groups; each set must fit.
     */
    @Test fun everyGroupThatCanShareOneScatterDrawFitsItsEightGroupSlots() {
        val src = WorldShaders.source(WorldShaders.realm.getValue(LifeLane.K_SCATTER).vs)
        val slots = Regex("""uniform ivec4 uGrp\[(\d+)]""").find(src)?.groupValues?.get(1)?.toInt() ?: error("SCATTER_VS declares no uGrp[]")
        assertEquals("the lane's per-draw group arrays are sized for the shader's slots", 8, slots)
        for (realm in file.tables.keys) {
            val gs = compiled(realm).groups
            val kit = gs.count { !it.mapOnly }; val twin = gs.count { it.twin }; val emit = gs.count { g -> g.species.any { it.emit != null } }
            assertTrue("$realm: $kit kit groups > $slots slots", kit <= slots)
            assertTrue("$realm: $twin twin groups > $slots slots", twin <= slots)
            assertTrue("$realm: $emit emitter groups > $slots slots", emit <= slots)
        }
    }

    /**
     * The glow's packing rule where no pack decides it: flag 4 and T4 = (anchor + the twin's frame offset, radius, period)
     * only for a map-only group's species that has both a glow and a twin (life.js buildTable); a glow on a kit group or a
     * twinless species packs its emitter texel as before. The fixture above holds only the true case (map objects).
     */
    @Test fun aLensGlowIsPackedOnlyForAMapOnlyTwinWithItsFrameOffset() {
        fun sprite(twin: LifeTwin?) = LifeSprite(100, 64 * 7, 60 * 7, 0.0, 0.0, 1, 1000).also { it.arr = c.noArray; it.twin = twin }
        val anchor = doubleArrayOf(32.0, 20.0)
        val lit = sprite(LifeTwin(3, 5, 64, 64, 32, 64, ox = 0, oy = 4)); val bare = sprite(null); val plain = sprite(LifeTwin(3, 6, 64, 64, 32, 64, 0, 4))
        val look = object : LifeLookup {
            override fun sprite(id: String) = when (id) { "lit" -> lit; "bare" -> bare; else -> plain }
            override fun creature(id: String): LifeSheet? = null
        }
        val row = { id: String, glow: DoubleArray? -> SpeciesRow(id, 1.0, listOf("ROCK"), false, null, glow) }
        val mapobj = GroupRow("mapobj", "mapobj", 15.0, linkedMapOf("ROCK" to 0.5), listOf(row("lit", anchor), row("bare", anchor), row("plain", null)),
            null, true, false, true, null, null)
        val kit = GroupRow("features", "feature", 30.0, linkedMapOf("ROCK" to 0.5), listOf(row("plain", anchor)), null, true, false, false, null, null)
        val life = sc.compileLife("x", LifeTable(doubleArrayOf(0.0, 0.0), null, null, null, listOf(mapobj, kit), null, null, emptyList()), look)!!
        val (t, _) = LifeLoad(file, sc).buildTable(life, emptyMap())
        val w = c.maxSpecies * c.spt
        fun texel(r: Int, x: Int) = (0 until 4).map { t[(r * w + x) * 4 + it].toInt() and 0xffff }
        val m = life.groups[0]; val f = life.groups[1]
        assertEquals("the lit beacon: flag 4, T4 = anchor + (ox, oy), radius, period",
            listOf(c.noArray or (4 shl 4), 32, 24, c.glow.radiusMap, c.glow.periodMs), listOf(texel(m.row, 0)[2]) + texel(m.row, 4))
        assertEquals("no twin: no glow", listOf(c.noArray, 0, 0, 0, 0), listOf(texel(m.row, c.spt)[2]) + texel(m.row, c.spt + 4))
        assertEquals("no anchor: no glow", c.noArray, texel(m.row, 2 * c.spt)[2])
        assertEquals("a kit group's species never glows", c.noArray, texel(f.row, 0)[2])
        assertTrue(m.hasGlow); assertTrue(!f.hasGlow)
    }

    private fun compiled(realm: String): CLife {
        val st = compile.get("realms").get(realm).get("stubs")
        val sp = LinkedHashMap<String, LifeSprite>()
        for (r in children(st.get("sprites"))) sp[r.getString(0)] = LifeSprite(r.getInt(1), r.getInt(2), r.getInt(3), r.getDouble(4), r.getDouble(5), r.getInt(6), r.getInt(7))
        val cr = LinkedHashMap<String, LifeSheet>()
        for (r in children(st.get("creatures"))) cr[r.getString(0)] = LifeSheet(r.getInt(1), r.getInt(2), r.getInt(3), r.getDouble(4), r.getInt(5), r.getInt(6), r.getString(7) == "water")
        val look = object : LifeLookup {
            override fun sprite(id: String) = sp[id.replace('-', '_')]
            override fun creature(id: String) = cr[id.replace('-', '_')]
        }
        val lm = children(st.get("landmarks")).map { it.asString() }
        val ob = children(st.get("objects")).map { it.getString(0) to (it.get(1).takeIf { x -> !x.isNull }?.asString()) }
        return sc.compileLife(realm, sc.lifeTable(file.tables[realm], lm, ob), look)!!
    }

    private fun build(pack: RealmPackFiles, realm: String): LifeBuild {
        val r = LifeLoad(file, sc).build(LanePack(pack) { _, key -> error("$key is not a PNG: the table fixture decodes PNG only") }, realm)
        return r.build ?: error("$realm: LIFE did not build (${r.why})")
    }

    companion object {
        const val SOLANA = "seeker-reach"
        val KEYS = listOf("tableW", "rows", "sha256", "groups", "glow", "missing", "darkTwinsReplaced", "arrays")

        /** The golden's projection of a build (tools/world-lifebases.mjs `lifeTableSuite`). */
        fun project(b: LifeBuild, spt: Int): Map<String, Any?> {
            val w = b.tableW
            val bytes = ByteArray(b.table.size * 2)
            for (i in b.table.indices) { val v = b.table[i].toInt(); bytes[2 * i] = v.toByte(); bytes[2 * i + 1] = (v shr 8).toByte() } // uint16 little-endian
            fun texel(r: Int, x: Int) = (0 until 4).map { b.table[(r * w + x) * 4 + it].toInt() and 0xffff }
            val glow = ArrayList<List<Any?>>()
            for (g in b.life.groups) for ((i, s) in g.species.withIndex()) {
                val t0 = texel(g.row, i * spt)
                if (((t0[2] shr 4) and 4) != 0) glow += listOf(g.id, g.row, i, s.id, t0, texel(g.row, i * spt + 4), texel(g.row, i * spt + 5))
            }
            return mapOf("tableW" to w, "rows" to b.tableRows, "sha256" to GoldenKit.sha256(bytes),
                "groups" to b.life.groups.map { listOf(it.id, it.row, it.species.size, it.hasGlow, it.hasTwins, it.hasEmit) },
                "glow" to glow, "missing" to b.missing.sorted(), "darkTwinsReplaced" to b.darkTwins.sorted(),
                "arrays" to b.arrays.map { listOf(it.key, it.lw, it.lh, it.mips.size) })
        }
    }
}

/**
 * The committed LIFE table fixture: the pinned pack's (pm1-cb8faa56909faa31) Solana Reach sprite, creature and map atlases
 * with its realm.json, and the shared fx, byte for byte. Every file is held to the pack manifest's sha256 (the realm files
 * again by realm.json's own `files` pins), so a fixture that drifted from the pack is refused, never compared.
 */
internal class FixturePack(private val bytes: (String) -> ByteArray?, private val pins: Map<String, String>) : RealmPackFiles {
    override fun read(path: String): ByteArray? = bytes(path)
    override fun expectedSha256(path: String): String? = pins[path]

    companion object {
        /** pack-manifest.json at pm1-cb8faa56909faa31 (web 205b6326), the files LIFE reads for Solana Reach. */
        val MANIFEST = mapOf(
            "realm/seeker-reach/realm.json" to "761df2e7f45c31150d998d3e579474b5c9d68724c1d7ec07e35135a390dbb6b2",
            "realm/seeker-reach/spr.png" to "e41adf4101432bebd4deb2510e108b63a64a0694a2ddf61900b9b89c9301e900",
            "realm/seeker-reach/mapkit.png" to "870a7627afd83d7f3f60c28fc1f9b4996feb0db5a9f97ad59003f1363c7041b4",
            "realm/shared/fx.json" to "c9f5e7c3a7c004cfe17e2b318af50bc29a1b7f6116d8b3a1ac9e17b0f9bb1d35",
            "realm/shared/fx.png" to "4db1e03e60f479d9efde876550627ad0420f39ffaccd1e8e64d23788c089c9e1",
        )

        fun classpath(): FixturePack {
            val read = { path: String -> LifeTableGoldenTest::class.java.getResourceAsStream("pack/$path")?.use { it.readBytes() } }
            for ((path, sha) in MANIFEST) {
                val b = read(path) ?: error("the LIFE table fixture pack/$path is missing (copy it from the pinned pack)")
                check(RealmLoader.sha256Hex(b) == sha) { "pack/$path is not the pinned pack's bytes" }
            }
            return FixturePack(read, MANIFEST)
        }
    }
}
