package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.JsMath
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeHash

/**
 * Native, not in bases.js (owner 2026-09-26, D-NEXT, Seeker code 31: "current keep display is extra not needed, on this
 * range only player profile picture and name should be visible"). The realm map shows a kingdom by its HUD name tag alone
 * until the BASES lane draws its real base, the live keep in its walls and fields. [drawsBase] tells the HUD when that
 * happens for the kingdom on catalog tile [tileId], so the tag gets its keep level back on the same frame as the base.
 *
 * The test is bases.js `baseMode(s, d, h7, h8) == KEEP`, using the lane's own seed (decor.js `seedOf(tileId)` =
 * `kitHash(id, 7331)`) and its two dither hashes (7 and 8), with the same bands. Each kingdom crosses at its own d between
 * `IMPOSTOR[0]` and `IMPOSTOR[1]`, like the lane. BaseHandOverTest pins it to [BasesRules.baseMode] and [Decor.seedOf].
 * [s] is CSS px per deed and [d] device px per deed (the engine's `cam.d`, the HUD frame's `cameraScale`).
 */
object BaseHandOver {
    private val bands = BasesBandsIn.fromGenerated()

    fun drawsBase(tileId: Int, s: Double, d: Double): Boolean {
        val sd = LifeHash.kitHash(tileId, SEED_SALT)
        val iconW = JsMath.clamp((s - bands.uiDots) / (bands.uiIcons - bands.uiDots), 0.0, 1.0)
        if (!(s >= bands.uiIcons || h01(sd, 7) < iconW)) return false // a dot
        val keepW = JsMath.clamp((d - bands.impostor0) / (bands.impostor1 - bands.impostor0), 0.0, 1.0)
        return d >= bands.impostor1 || h01(sd, 8) < keepW
    }

    private fun h01(seed: Int, k: Int): Double = JsMath.u32(LifeHash.kitHash(seed, k)) / 4294967296.0
    /** decor.js `seedOf(id)`: `hash2(id | 0, 7331)`. */
    private const val SEED_SALT = 7331
}
