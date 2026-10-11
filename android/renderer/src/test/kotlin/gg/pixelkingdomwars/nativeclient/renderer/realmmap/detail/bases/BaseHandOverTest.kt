package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmEngineWiring
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGrid
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.GoldenKit
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.JsMath
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeHash
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * D-NEXT (owner 2026-09-26, Seeker code 31): "keep is displayed very ugly on current screen, zoomed in base is much
 * better ... on this range only player profile picture and name should be visible". In that range the HUD's name tag is
 * all the map shows of a kingdom, so the tag drops the keep level, and it gets the level back on the frame the BASES lane
 * draws the kingdom's real base. The HUD cannot ask the lane, so [BaseHandOver.drawsBase] recomputes the lane's decision.
 * This pins it to the lane's own inputs: the golden-tested [BasesRules.baseMode] (bases.js), the lane's seed
 * ([Decor.seedOf] of the catalog tile id) and its dither hashes 7 and 8. If the two drifted, a tag would show a level
 * over an empty plot, or lose it over a drawn base.
 */
class BaseHandOverTest {
    private val t = DecorTables.load()
    private val game = DecorGame.fromCatalogue(GoldenKit.catalogue())
    private val decor = Decor(t, game, RealmEngineWiring.plots(game.claimTilesByKeep, game.wallRingsByKeep, game.tilesPerDeed))
    private val bands = BasesBandsIn.fromGenerated()
    private val rules = BasesRules(t, bands.uiDots, bands.uiIcons, bands.keepMinCss, bands.impostor0, bands.impostor1)

    /** The lane's decision for the kingdom on [tileId] (BasesLane: `seeds = decor.seedOf(id)`, `baseMode(s, d, h7, h8)`). */
    private fun laneKeep(tileId: Int, s: Double, d: Double): Boolean {
        val sd = decor.seedOf(tileId.toDouble()).toInt()
        fun h(k: Int) = JsMath.u32(LifeHash.kitHash(sd, k)) / 4294967296.0
        return rules.baseMode(s, d, h(7), h(8)) == BasesRules.KEEP
    }

    @Test fun `the HUD's hand-over is the lane's live keep for every kingdom and every camera`() {
        val tiles = IntArray(4000) { i -> ((i * 2654435761L) % (RealmGrid.LATTICE_W.toLong() * RealmGrid.LATTICE_H)).toInt() }
        var compared = 0; var live = 0
        for (dpr in doubleArrayOf(1.0, 2.0, 2.625, 3.0)) {
            val ds = doubleArrayOf(bands.uiDots * dpr, 120.0, 150.0, bands.impostor0 - 1e-9, bands.impostor0, 215.0, 240.0, 265.0,
                bands.impostor1 - 1e-9, bands.impostor1, 700.0, 1400.0)
            for (d in ds) for (tile in tiles) {
                val s = d / dpr
                val want = laneKeep(tile, s, d)
                assertEquals("tile $tile s=$s d=$d", want, BaseHandOver.drawsBase(tile, s, d))
                compared++; if (want) live++
            }
        }
        assertTrue("both answers occur (not a vacuous pass): $live of $compared live", live in 1 until compared)
    }

    @Test fun `below IMPOSTOR 0 no kingdom has its base, from IMPOSTOR 1 every kingdom has it, and between they cross one by one`() {
        val tiles = (0 until 2000).map { it * 131 + 7 }
        assertFalse(tiles.any { BaseHandOver.drawsBase(it, bands.impostor0 / 2, bands.impostor0 - 1e-9) })
        assertTrue(tiles.all { BaseHandOver.drawsBase(it, bands.impostor1 / 2, bands.impostor1) })
        val mid = tiles.count { BaseHandOver.drawsBase(it, 120.0, 240.0) }
        // the dither is uniform: half the kingdoms have crossed at the band's middle
        assertEquals(tiles.size / 2.0, mid.toDouble(), tiles.size * 0.05)
    }
}
