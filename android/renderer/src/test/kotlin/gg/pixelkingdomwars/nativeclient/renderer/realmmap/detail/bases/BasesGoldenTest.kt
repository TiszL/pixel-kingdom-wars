package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Bands
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmEngineWiring
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.Close
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.Deep
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.GoldenKit
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.GoldenKit.children
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.GoldenKit.hashOf
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.JsMath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BASES parity with the pinned web engine (tools/world-lifebases.mjs goldens, GLOBE-NATIVE-PLAN §7 "decor", 100 %).
 * Why it matters: a base's MAP minis, TRUE sprites, walls, fields and lanes all come from `composeBaseDecor`; if the port
 * drifted by one tile the web and the native map would draw a different kingdom on the same deed (and the MAP → TRUE
 * dissolve would jump), and a catalogue that drifted from the pin would silently re-lay every plot. Exact, bit for bit.
 */
class BasesGoldenTest {
    private val t = DecorTables.load()
    private val cat = GoldenKit.catalogue()
    private val game = DecorGame.fromCatalogue(cat)
    private val plots = RealmEngineWiring.plots(game.claimTilesByKeep, game.wallRingsByKeep, game.tilesPerDeed)
    private val decor = Decor(t, game, plots)
    private fun golden(name: String) = GoldenKit.json(BasesGoldenTest::class.java, name)

    private fun projSprite(s: DecorSprite): List<Any?> = listOf(s.key, s.atlas, s.kind, s.role, s.fam, s.fx, s.fy, s.fp, s.tx, s.ty, s.z, s.anchor, s.scale, s.cell, s.ink,
        s.rows, if (s.clip) listOf(s.clipFrames, s.clipMs) else null, if (s.flipX) 1 else 0, s.phase)
    private fun projDecor(d: BaseDecor): List<Any?> {
        val g = d.geometry
        return listOf(d.level, d.realmId, d.formation, d.seed,
            listOf(g.s, g.a, g.b, g.ring, g.p0, g.p1, g.o0, g.o1, if (g.doubled) 1 else 0, g.wIn, g.wInHi, g.citadel, g.court, g.wallRings, g.wallTier, g.lanes, g.keep),
            d.claim, d.plot,
            listOf(d.keep.key, d.keep.tx, d.keep.ty, d.keep.z, d.keep.anchor, d.keep.scale, d.keep.cell, d.keep.ink, d.keep.fp, d.keep.fx, d.keep.fy),
            d.walls.map { listOf(it.tier, it.x, it.y, it.piece, it.ring) },
            d.sprites.map(::projSprite),
            d.emitters.map { listOf(it.kind, it.attach, it.tx, it.ty, it.dx, it.dy, it.r, it.a) },
            d.omitted, d.edges.map { listOf(it.style, it.x, it.y, it.piece, it.mask, it.loop) },
            d.ground.map { listOf(it.x, it.y, it.k, it.t, it.p) },
            listOf("N", "S", "W", "E").map { s -> d.lanes[s]?.map { it.toList() } }, listOf("N", "S", "W", "E").map { d.laneEnds[it] }, d.gates,
            d.patches.map { listOf(it.kind, it.seg, it.cells, it.crop, it.hedged?.let { h -> if (h) 1 else 0 }) },
            decor.edgeSprites(d).map(::projSprite), decor.edgeAutotileSprites(d).map(::projSprite), decor.wallSprites(d).map(::projSprite))
    }

    @Test fun theCatalogueHoldsThePinsGameNumbers() {
        // decor.js read these from packages/shared at the pin; the native port reads the ACTIVE catalogue. A drift fails
        // here (loud) instead of re-laying every kingdom differently from the web.
        val p = golden("golden-decor.json").get("pinnedGame")
        assertEquals(Deep.json(p.get("claimTilesByKeep")), Deep.kotlin(game.claimTilesByKeep))
        assertEquals(Deep.json(p.get("wallRingsByKeep")), Deep.kotlin(game.wallRingsByKeep))
        assertEquals(p.getInt("outerWallInset"), game.outerWallInset)
        assertEquals(p.getInt("worldTiles"), game.tilesPerDeed); assertEquals(p.getInt("tilePx"), game.art)
        assertEquals(Deep.json(p.get("maxMinesByKeep")), Deep.kotlin(game.maxMinesByKeep))
        for (c in children(p.get("buildCountCapByKeep"))) assertEquals(c.name, Deep.json(c), Deep.kotlin(game.buildCaps[c.name]))
        for (c in children(p.get("footprints"))) assertEquals(c.name, Deep.json(c), Deep.kotlin(game.footprints[c.name]))
        for (c in children(p.get("presentation"))) if (!c.isNull) {
            assertEquals(c.name, c.getDouble(0), game.sourceScale.getValue(c.name), 0.0)
            assertEquals(c.name, c.get(1).getDouble(0), game.offsetGamePxX.getValue(c.name), 0.0)
        }
        assertEquals(Deep.json(p.get("wallCapForKeepLevel")), Deep.kotlin((1..20).map { game.wallCap(it) }))
        assertEquals(t.pin, golden("golden-decor.json").getString("pin"))
    }

    @Test fun composeBaseDecorLaysTheSameKingdomForEveryRealmLevelSeedAndGateSet() {
        val g = golden("golden-decor.json")
        var n = 0; var sprites = 0; val realms = LinkedHashSet<String>()
        for (row in children(g.get("results"))) {
            val realm = row.getString(0); val level = row.getInt(1); val seed = row.getLong(2); val gates = row.getString(3).map { it.toString() }
            val proj = try { val d = decor.compose(level, realm, seed, gates); sprites += d.sprites.size; projDecor(d) } catch (e: IllegalStateException) { listOf("throw", e.message) }
            assertEquals("$realm L$level seed $seed gates ${row.getString(3)}", row.getString(4), hashOf(proj))
            n++; realms += realm
        }
        // stage B dresses every realm with a map: Elderwood, Thornwake and Solana Reach joined the five (their kingdoms
        // were bare keeps with 'bases no kit dressing' before), each over 20 levels × 8 seeds × 4 gate sets
        assertEquals(t.realmsWithMaps.toSet(), realms)
        assertTrue("the stage-B realms are composed: $realms", realms.containsAll(listOf("elderwood", "thornwake", "seeker-reach")))
        assertEquals(8 * 20 * 8 * 4, n)
        assertTrue("real kingdoms were composed ($sprites sprites)", sprites > 100_000)
        for (f in children(g.get("full"))) {
            val d = decor.compose(f.getInt("level"), f.getString("realm"), f.getLong("seed"), children(f.get("gates")).map { it.asString() })
            assertEquals("${f.getString("realm")} L${f.getInt("level")} full projection", Deep.json(f.get("projection")), Deep.kotlin(projDecor(d)))
        }
    }

    @Test fun geometryKeepLadderHashesSeedsAndCapsMatch() {
        val g = golden("golden-decor.json")
        assertEquals(Deep.json(g.get("geometry")), Deep.kotlin((1..20).map { L -> val p = decor.plotGeometry(L)
            listOf(p.level, p.s, p.a, p.b, p.ring, p.p0, p.p1, p.o0, p.o1, if (p.doubled) 1 else 0, p.wIn, p.wInHi, p.citadel, p.court, p.wallRings, p.wallTier) }))
        // keepScale is Math.pow: within 1e-12 of V8 (not fdlibm); every other value is exact
        Close.assertClose("keep", g.get("keep"), (1..20).map { L -> val e = decor.keepExtents(L); val r = decor.keepInkRect(L, 1.5)
            listOf(L, decor.kFit(L), listOf(e.left, e.right, e.up, e.down, e.w, e.h), listOf(r.x0, r.x1, r.y0, r.y1),
                doubleArrayOf(100.0, 200.0, 280.0, 281.0, 400.0, 799.0, 1000.0, 1099.0, 1100.0, 3000.0).map { decor.keepScale(L, it) }, decor.decorBand(L)) })
        val ladder = ArrayList<List<Any?>>()
        for (L in 1..20) for (seed in longArrayOf(0, 5, 77, 123456, 0xffffffffL)) ladder += listOf(L, seed, decor.fieldCount(L, seed), decor.ringWants(L, seed), decor.mainGate(seed))
        assertEquals(Deep.json(g.get("ladder")), Deep.kotlin(ladder))
        val hashes = (0 until 40).map { i -> val a = (i.toLong() * 2246822519L).toInt(); val b = (i.toLong() * 3266489917L + 12345).toInt(); listOf(a, b, JsMath.u32L(decor.hash2(a, b))) }
        assertEquals(Deep.json(g.get("hashes")), Deep.kotlin(hashes))
        for (row in children(g.get("seedOf"))) {
            val v = row.get(0)
            val got = if (v.isString) decor.seedOf(v.asString().removePrefix("s:")) else decor.seedOf(v.asDouble())
            assertEquals(Deep.json(row), Deep.kotlin(listOf(if (v.isString) v.asString() else v.asDouble(), got)))
        }
        for (c in children(g.get("caps"))) assertEquals(c.name, Deep.json(c), Deep.kotlin((1..20).map { listOf(decor.decorCountCap(c.name, it), decor.decorCap(c.name, it)) }))
        for (c in children(g.get("scales"))) assertEquals(c.name, Deep.json(c), Deep.kotlin(listOf(decor.scaleOf(c.name), decor.footprintOf(c.name))))
    }

    /**
     * decor.js `composeBaseDecor` gates on `KIT_DRESSING[realmId]` (stage B, aff798ad), not on SHELL's REALMS_WITH_MAPS: a
     * realm is composed exactly when its kit dresses it. The two lists are equal at the pin, so the golden above cannot
     * tell the rules apart; this does, by pulling them apart. Why it matters: a realm listed as mapped but undressed must
     * throw (there is no kit to seat), and a dressed realm must compose whatever the map list says.
     */
    @Test fun theKitDressingIsTheComposersGateNotTheRealmList() {
        val json = DecorTables::class.java.getResourceAsStream(DecorTables.RESOURCE)!!.use { String(it.readBytes(), Charsets.UTF_8) }
        // the map list swaps thornwake (dressed) for atlantis (undressed); KIT_DRESSING is untouched
        val swapped = Regex("(\"REALMS_WITH_MAPS\": \\[[^\\]]*)\"thornwake\"").replace(json) { it.groupValues[1] + "\"atlantis\"" }
        val pulled = DecorTables.parse(swapped)
        assertFalse(pulled.realmsWithMaps.contains("thornwake")); assertTrue(pulled.realmsWithMaps.contains("atlantis"))
        assertTrue(pulled.dressing.containsKey("thornwake")); assertFalse(pulled.dressing.containsKey("atlantis"))
        val d2 = Decor(pulled, game, plots)
        val tw = d2.compose(9, "thornwake", 77, listOf("N"))
        assertTrue("thornwake is dressed: it composes though the map list dropped it", tw.sprites.isNotEmpty())
        assertEquals(hashOf(projDecor(decor.compose(9, "thornwake", 77, listOf("N")))), hashOf(projDecor(tw)))
        val e = try { d2.compose(9, "atlantis", 77, emptyList()); null } catch (x: IllegalStateException) { x.message }
        assertEquals("decor: no kit dressing for realm 'atlantis'", e)
    }

    // ---------------------------------------------------------------- bases.js pure rules

    private val rules = BasesRules(t, Bands.UI_DOTS.toDouble(), Bands.UI_ICONS.toDouble(), Bands.KEEP_MIN_CSS.toDouble(), Bands.IMPOSTOR[0].toDouble(), Bands.IMPOSTOR[1].toDouble())

    @Test fun markerModesLooksTapOrderShieldCapsAndReducersMatch() {
        val g = golden("golden-bases.json")
        val names = arrayOf("dot", "icon", "keep")
        for (r in children(g.get("baseMode"))) assertEquals(r.toString(), r.getString(4), names[rules.baseMode(r.getDouble(0), r.getDouble(1), r.getDouble(2), r.getDouble(3))])
        for (r in children(g.get("iconLook"))) { val k = rules.iconLook(r.getInt(0), r.getLong(1).toInt())
            assertEquals(Deep.json(r), Deep.kotlin(listOf(r.getInt(0), r.getLong(1), k.css, k.tips, k.towers, k.tower, k.first))) }
        val rng = GoldenKit.Rng(99); val mine = BooleanArray(70) { it == 13 || it == 50 }; val dist = DoubleArray(70) { Math.floor(rng.next() * 40) / 4 }
        for ((lod, want) in children(g.get("capShields")).withIndex()) {
            val order = IntArray(70) { it }; val n = rules.capShields(order, 70, mine, dist, lod)
            assertEquals("lod $lod", Deep.json(want), Deep.kotlin(order.take(n)))
        }
        val rects = Array(30) { i -> BasesRules.KeepRect(i, (i % 6) * 40.0, (i / 6) * 30.0, (i % 6) * 40.0 + 60, (i / 6) * 30.0 + 50, ((i * 37) % 11).toDouble()) }
        val domes = Array(8) { i -> BasesRules.DomeHit(100 + i, 300.0 + i * 25, 200.0 + (i % 3) * 20, 30.0, 16.0) }
        val picks = ArrayList<Int>(); var y = -5; while (y < 260) { var x = -5; while (x < 520) { picks += rules.pickBase(rects, 30, domes, 8, x.toDouble(), y.toDouble()); x += 17 }; y += 13 }
        assertEquals(Deep.json(g.get("pickBase")), Deep.kotlin(picks))
        var clock = 0.0; val w = BasesRules.FrameWork(4.0) { clock }; val trace = ArrayList<Int>(); w.begin()
        for (i in 0 until 12) { trace += if (w.more()) 1 else 0; if (i % 3 == 0) w.spend(); clock += 1.1 }
        assertEquals(Deep.json(g.get("frameWork")), Deep.kotlin(trace))
        for (r in children(g.get("reduceMode"))) {
            val img = GoldenKit.synthImage(r.getInt(0), r.getInt(1), r.getLong(2))
            val out = BasesPixels.reduceMode(img.data, r.getInt(0), r.getInt(1), r.getDouble(3), darkW = r.getDouble(4))
            assertEquals(r.toString(), Deep.json(r), Deep.kotlin(listOf(r.getInt(0), r.getInt(1), r.getLong(2), r.getDouble(3), r.getDouble(4), out.w, out.h, GoldenKit.sha256(out.px))))
        }
    }

    /**
     * bases.js `iconAnchorY(d, inkMid)` (stage B fix pass, 090b3428): at MAP d ≤ 150 a marker icon's ink is centred on its
     * plot, from d 200 (BANDS.impostor[0], the first icon → live-keep switch) it stands on the keep seat, smoothstep in
     * log d between. Why it matters: before the fix the icon sat in the top half of its clearing ("the keep icon at the top
     * edge of its pad"), and the tap rects and the selection ring follow the drawn icon; the composed pick golden sees
     * only the Seeker cameras, this pins the curve itself (log: relative 1e-12, the golden's tolerance).
     */
    @Test fun theMarkerIconIsCentredOnItsPlotAtMapAndEasesOntoTheKeepSeatByTheSwitch() {
        val g = golden("golden-bases.json")
        assertEquals(Deep.json(g.get("iconCentreD")), Deep.kotlin(t.iconCentreD.toList()))
        assertEquals("ICON_CENTRE_D[1] is BANDS.impostor[0]", Bands.IMPOSTOR[0].toDouble(), t.iconCentreD[1], 0.0)
        val centre = plots.plotCentre.toDouble(); val seat = game.keepFootprint[1] / 2.0 + centre
        val rows = children(g.get("iconAnchorY"))
        assertEquals(14 * 6, rows.size)
        Close.assertClose("iconAnchorY", g.get("iconAnchorY"), rows.map { r -> listOf(r.getDouble(0), r.getDouble(1), rules.iconAnchorY(r.getDouble(0), r.getDouble(1), centre, seat)) })
        // the ends, exactly: centred (the ink's middle on the plot centre) at d 150, on the seat at d 200
        assertEquals(centre + 0.8, rules.iconAnchorY(150.0, -0.8, centre, seat), 0.0)
        assertEquals(seat, rules.iconAnchorY(200.0, -0.8, centre, seat), 0.0)
    }

    // ---------------------------------------------------------------- demo population (debug fallback) and paths

    private fun deeds(v: JsonValue): ByteArray {
        val out = ByteArray(v.getInt("cols") * v.getInt("rows")); val rle = v.get("deedsRle").asIntArray(); var o = 0
        var i = 0; while (i < rle.size) { for (k in 0 until rle[i + 1]) out[o++] = rle[i].toByte(); i += 2 }
        assertEquals(out.size, o)
        return out
    }
    private val demo = DemoBases(t)
    private fun projBase(b: MapBase): List<Any?> = listOf(b.id, b.x, b.y, b.level, b.name, b.avatar, b.trophies, b.clan, if (b.mine) 1 else 0, if (b.shield == true) 1 else 0, if (b.attackable) 1 else 0)

    @Test fun theDebugDemoPopulationIsTheWebsForEveryRealm() {
        val g = golden("golden-demo.json")
        var realms = 0
        for (r in children(g.get("realms"))) {
            val cols = r.getInt("cols"); val rows = r.getInt("rows"); val dd = deeds(r)
            val bases = demo.demoBases(r.name, cols, rows, dd, 255)
            val proj = bases.map(::projBase)
            assertEquals("${r.name} count", r.getInt("count"), bases.size)
            assertEquals("${r.name} first", Deep.json(r.get("first")), Deep.kotlin(proj.take(25)))
            assertEquals("${r.name} hash", r.getString("hash"), hashOf(proj))
            val copies = bases.map { MapBase(it.id, it.x, it.y, it.level, it.name, it.avatar, it.trophies, it.clan, it.mine, it.shield, it.attackable) }.toMutableList()
            val ladder = demo.ladderBases(copies, cols, rows, dd, 255).map { listOf(it.id, it.x, it.y, it.level, if (it.shield == true) 1 else 0, if (it.attackable) 1 else 0) }
            assertEquals("${r.name} ladder", r.getString("ladder"), hashOf(ladder))
            realms++
        }
        assertEquals(8, realms)
    }

    @Test fun pathsBetweenKingdomsAndTheirTerrainSettleMatch() {
        val gd = golden("golden-demo.json"); val g = golden("golden-paths.json")
        val env = GoldenKit.Env(emptyList())
        val terrain = PathTerrainRules(t.pathTerrain, game.tilesPerDeed)
        for (r in children(g.get("realms"))) {
            val dv = gd.get("realms").get(r.name)
            val bases = demo.demoBases(r.name, dv.getInt("cols"), dv.getInt("rows"), deeds(dv), 255)
            val net = BasePathsJob(bases.map { PathBase(it.idString, decor.seedOf(it.id), it.x, it.y, it.level) }, plots, t.paths, game.tilesPerDeed).run()
            assertEquals("${r.name} links", r.getInt("links"), net.links.size)
            assertEquals("${r.name} segments", r.getInt("segments"), net.segments.size)
            val links = net.links.map { listOf(it.a, it.b, it.sa, it.sb, it.pts.map { p -> p.toList() }, it.seed) }
            assertEquals("${r.name} first links", Deep.json(r.get("firstLinks")), Deep.kotlin(links.take(6)))
            val proj = listOf(net.segments.map { listOf(listOf(it.ax, it.ay), listOf(it.bx, it.by), it.seed) }, links, net.sides.map { (k, s) -> listOf(k, s.toList()) })
            assertEquals("${r.name} network", r.getString("network"), hashOf(proj))
            val settled = ArrayList<Any?>()
            for (l in net.links.take(400)) for (bridge in booleanArrayOf(true, false)) {
                val s = terrain.settle(l.pts, env::classAt, bridge)
                settled += if (s == null) null else listOf(s.segments.map { listOf(listOf(it.ax, it.ay), listOf(it.bx, it.by), if (it.ford) 1 else 0, if (it.bridge) 1 else 0) },
                    s.crossings.map { listOf(it.axis, it.kind, it.from.toList(), it.to.toList()) })
            }
            assertEquals("${r.name} settled", r.getString("settled"), hashOf(settled))
            assertEquals(r.getInt("settledDropped"), settled.count { it == null })
            val bridges = listOf("ew", "ns").map { axis -> val p = decor.bridgePiece(r.name, axis)
                if (p == null) listOf(axis, null) else listOf(axis, p.key, p.fp, p.anchor, p.ink, p.scale,
                    listOf(Crossing(axis, "bridge", doubleArrayOf(100.5, 40.25), doubleArrayOf(106.5, 40.25)), Crossing(axis, "bridge", doubleArrayOf(80.0, 12.5), doubleArrayOf(80.0, 21.0)),
                        Crossing(axis, "bridge", doubleArrayOf(3.0, 3.0), doubleArrayOf(3.0, 3.0))).map { cr -> terrain.bridgeSeats(cr, p).map { it.toList() } }) }
            assertEquals("${r.name} bridges", Deep.json(r.get("bridges")), Deep.kotlin(bridges))
        }
    }

    @Test fun theSlicedPathJobEqualsTheWholeRun() {
        // bases.js runs basePathsJob under a per-frame budget: however it is sliced, the network is the same
        val gd = golden("golden-demo.json").get("realms").get("cinderfall")
        val bases = demo.demoBases("cinderfall", gd.getInt("cols"), gd.getInt("rows"), deeds(gd), 255).map { PathBase(it.idString, decor.seedOf(it.id), it.x, it.y, it.level) }
        val whole = BasePathsJob(bases, plots, t.paths, game.tilesPerDeed).run()
        val job = BasePathsJob(bases, plots, t.paths, game.tilesPerDeed); var steps = 0
        while (!job.step()) steps++
        assertTrue("the job yields many times ($steps)", steps > bases.size)
        assertEquals(hashOf(whole.links.map { listOf(it.a, it.b, it.sa, it.sb) }), hashOf(job.result!!.links.map { listOf(it.a, it.b, it.sa, it.sb) }))
    }
}
