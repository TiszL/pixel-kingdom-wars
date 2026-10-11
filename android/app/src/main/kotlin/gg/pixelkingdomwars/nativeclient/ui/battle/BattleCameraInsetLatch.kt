package gg.pixelkingdomwars.nativeclient.ui.battle

import gg.pixelkingdomwars.nativeclient.renderer.CameraInsets

/** What one battle chrome measurement is valid for: this raid, this viewport, this safe area. A measured height on
 * its own does not say which layout produced it. A chained raid (NEXT TARGET, NEXT RAID, NEXT STAGE) reuses the
 * screen and its coordinator while the previous raid's heights are still in state, and a rotation keeps the whole
 * composition (MainActivity handles the configuration change) and recomposes the scene before the chrome is
 * remeasured. */
internal data class BattleCameraEnvironment(val raidId: String?, val width: Int, val height: Int, val safe: CameraInsets)

/** A chrome column's height, tagged by its own measure pass with the environment that pass was composed under. */
internal data class BattleChromeMeasure(val pixels: Int, val environment: BattleCameraEnvironment)

/** The battle camera is framed against the chrome once per battlefield, viewport and safe area, never per HUD row.
 * The renderer refits an untouched camera whenever its insets change (NativeGameRenderer.renderFrame), which is
 * right for the first measurement of the HUD and tray and wrong afterwards: a status row, a wrapped pill or an
 * error line changed the measured heights mid-battle and every such change jumped the camera (owner 2026-09-18).
 * Only a framing whose HUD and tray were both measured under the current environment is held. Anything else — no
 * chrome yet (the scene opens before its chrome exists), the previous raid's terminal tray, the other orientation's
 * heights — passes through unheld, so the camera follows the measurements exactly as it did before the latch until
 * this environment's own layout pass reports. Explicit FIT and a new destination keep their renderer paths and use
 * the held framing. */
internal class BattleCameraInsetLatch {
    private var environment: BattleCameraEnvironment? = null
    private var held: CameraInsets? = null
    fun resolve(environment: BattleCameraEnvironment, live: CameraInsets, hud: BattleChromeMeasure?, tray: BattleChromeMeasure?): CameraInsets {
        if (environment != this.environment) { this.environment = environment; held = null }
        held?.let { return it }
        if (listOf(hud, tray).all { it != null && it.pixels > 0 && it.environment == environment }) held = live
        return live
    }
}
