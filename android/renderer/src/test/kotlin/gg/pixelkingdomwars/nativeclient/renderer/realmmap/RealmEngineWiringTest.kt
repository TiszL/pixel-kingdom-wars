package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import org.junit.Test
import kotlin.test.assertEquals

/**
 * The production engine inputs come from the generated constants and the catalogue only, and they are the values the
 * golden suites were checked with ([RealmWebPin], itself checked against the pinned web contracts by
 * [RealmGoldenTest]). A generator change that drops or renames a constant fails to compile; one that changes a value
 * fails here, before the Seeker sees a different band edge.
 */
class RealmEngineWiringTest {
    @Test fun `the generated engine config is the pinned web config`() {
        val got = RealmEngineWiring.config(); val want = RealmWebPin.CONFIG
        val gb = got.bands; val wb = want.bands
        assertEquals(listOf(wb.farEnd, wb.mapStart, wb.trueStart, wb.trueFull, wb.restEaseMs, wb.selectD, wb.myBaseD, wb.herds, wb.creatures, wb.sway, wb.snap, wb.sMax, wb.uiDots, wb.uiIcons, wb.keepMinCss),
            listOf(gb.farEnd, gb.mapStart, gb.trueStart, gb.trueFull, gb.restEaseMs, gb.selectD, gb.myBaseD, gb.herds, gb.creatures, gb.sway, gb.snap, gb.sMax, gb.uiDots, gb.uiIcons, gb.keepMinCss))
        assertEquals(wb.rest.toList(), gb.rest.toList()); assertEquals(wb.impostor.toList(), gb.impostor.toList()); assertEquals(wb.twins.toList(), gb.twins.toList())
        assertEquals(wb.edges.toList(), gb.edges.toList())
        val gr = got.rehearsal; val wr = want.rehearsal
        assertEquals(listOf(wr.idleMs, wr.gapMs, wr.retryMs, wr.retryMaxMs, wr.stallMs, wr.mapReadyHoldMs), listOf(gr.idleMs, gr.gapMs, gr.retryMs, gr.retryMaxMs, gr.stallMs, gr.mapReadyHoldMs))
        assertEquals(wr.box, gr.box); assertEquals(wr.trueSet, gr.trueSet); assertEquals(wr.order, gr.order)
        assertEquals(want.groundPx.toList(), got.groundPx.toList()); assertEquals(want.heavy.toList(), got.heavy.toList())
        assertEquals(listOf(want.chartPassFetches, want.mapPassFetches, want.truePassFetches, want.displayBudget, want.resolveBudget, want.evictMs, want.dprCap, want.deedDeg),
            listOf(got.chartPassFetches, got.mapPassFetches, got.truePassFetches, got.displayBudget, got.resolveBudget, got.evictMs, got.dprCap, got.deedDeg))
        assertEquals(want.coldUploadBytes, got.coldUploadBytes)
        assertEquals(want.deedThisRealm, got.deedThisRealm); assertEquals(want.deedOtherRealm, got.deedOtherRealm)
    }

    @Test fun `plot rules built from the catalogue through the wiring are the tested ones`() {
        val t = RealmTestData.plots
        val claims = IntArray(t.maxLevel) { t.rule(it + 1).claim }; val walls = IntArray(t.maxLevel) { t.rule(it + 1).wallRings }
        val w = RealmEngineWiring.plots(claims, walls, t.tiles)
        for (L in 1..t.maxLevel) for ((x, y) in listOf(0 to 0, 118 to 58, 719 to 359, -5 to 3)) {
            assertEquals(t.centreX(x, y, L), w.centreX(x, y, L)); assertEquals(t.centreY(x, y, L), w.centreY(x, y, L))
        }
        assertEquals(RealmWebPin.DEED_ART, RealmEngineWiring.deedArt(t.tiles, 32))
        val fromApp = RealmEngineWiring.fromCatalogue(java.io.File("../app/src/main/assets/native/catalogue.json").readText())
        assertEquals(RealmWebPin.DEED_ART, fromApp.deedArt, "worldTiles × GRID.tilePx from the app's catalogue is the web's DEED_ART")
        for (L in 1..t.maxLevel) assertEquals(t.centreX(118, 58, L), fromApp.plots.centreX(118, 58, L))
    }

    @Test fun `the host's parsers read the app's catalog and the debug content manifest the loader verifies against`() {
        val parsed = RealmCatalog.parse(java.io.File("../app/src/main/assets/native/fantasy/world-v1.json").readText())
        val ref = RealmTestData.catalog
        assertEquals(ref.realmIds, parsed.realmIds)
        for (id in ref.realmIds) assertEquals(ref.deedCount(id), parsed.deedCount(id), id)
        for (tile in listOf(0, 14030, 14044, 14045, 64907, 129599)) assertEquals(ref.realmOf(tile), parsed.realmOf(tile), "tile $tile")
        val hashes = RealmLoader.contentHashes("""{"files":[{"path":"realm/index.json","sha256":"ab","bytes":1},{"path":"realm/x/deeds.png","sha256":"cd","bytes":2}]}""")
        assertEquals(mapOf("realm/index.json" to "ab", "realm/x/deeds.png" to "cd"), hashes)
    }

    @Test fun `a globe snapshot fades out over the live realm on a dive, a realm snapshot fades out over the globe on a leave`() {
        val fade = RealmDiveFade(RealmGlRig().core, RealmDiveFade.PLAN_FADE_MS)
        fade.start(RealmDiveFade.DIVE, 0.0, snapshotIsRealm = false)
        assertEquals(1.0, fade.snapshotAlpha(0.0)); assertEquals(0.0, fade.snapshotAlpha(RealmDiveFade.PLAN_FADE_MS))
        fade.start(RealmDiveFade.LEAVE, 0.0)
        assertEquals(1.0, fade.snapshotAlpha(0.0)); assertEquals(0.0, fade.snapshotAlpha(RealmDiveFade.PLAN_FADE_MS))
        fade.start(RealmDiveFade.DIVE, 0.0)
        assertEquals(0.0, fade.snapshotAlpha(0.0), "a realm snapshot rises over the globe on a dive")
    }
}
