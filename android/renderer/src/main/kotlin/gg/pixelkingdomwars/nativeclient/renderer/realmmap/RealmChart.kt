package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.graphics.GL20
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Units
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture

/**
 * The web's FAR ground: GROUND's `rm-chart` (chart.glsl.js, exported verbatim), the painted chart that fades into the
 * realm's own open sea — the fix for the owner's "cut picture" when zooming out (2026-09-25). Outside the grid it draws
 * `uSeaFar`; inside, `rmKeep` eases the painting into `uSeaFar` beyond the noisy foreign cut (1.5…6.5 deeds from this
 * realm's deeds, the far field `uFar`) and within 3 deeds of the painting's frame. So the realm always sits in its own sea
 * with a soft coast, never the chart rectangle on navy (`stub-ground`'s hard cut). Other realms' land is drawn as the
 * realm art paints it, with no per-deed veil (owner 2026-09-26, pin 02e9da84); the catalog deeds stay bound on
 * [UNIT_DEEDS] as ground.js binds them, but the stage no longer samples them.
 *
 * The one implementation of ground.js `drawChart`'s bindings (Rule 7): the core draws it from the first-frame set
 * (chart8, the catalog deeds, the far field, the ring sea) with ground.js's own stand-ins for what that set lacks —
 * `uChart16` a 1×1 RGBA8 array with `uC16Geo.w` 0 (the uniforms' link-time zero: pages off), and `uFieldsA` a neutral
 * 1×1 texel (coast 0: no glints until the real coast field; ground.js binds a zero texel there, which sparkles glints
 * over land until its MAP data lands — not copied). A ground lane with chart16 pages or the real fieldsA passes its own
 * textures and sets its `uC16Page`/`uC16Geo` uniforms before [draw]. Units are `UNITS.chart` and ground.js's `uFar` 5.
 */
object RealmChart {
    const val UNIT_CHART8 = Units.CHART_CHART8
    const val UNIT_CHART16 = Units.CHART_CHART16
    const val UNIT_DEEDS = Units.CHART_DEEDS
    const val UNIT_FIELDS_A = Units.CHART_FIELDS_A
    /** ground.js `drawChart`: `.tex('uFar', 5, T.far)` (UNITS.chart stops at fieldsA 4). */
    const val UNIT_FAR = 5
    /** chart.glsl.js `coastAt`: `(texel.r · 255 − 128) · 2` tiles; 128 = coast 0, which is never `< −6` (no glint). */
    const val NEUTRAL_COAST: Byte = 128.toByte()

    /**
     * Bind [program] with the chart's textures and uniforms (GL thread, inside a pass). False when the program is not
     * ready. [sea] is the painting's open-sea colour (ground.js `palette().seaFar` = minimap.js `ringSea`, 0..1 RGB).
     */
    fun bind(core: Gl3Core, program: Gl3Program, chart8: Gl3Texture, chart16: Gl3Texture, deeds: Gl3Texture, fieldsA: Gl3Texture,
             far: Gl3Texture, sea: FloatArray, alpha: Double): Boolean {
        if (!core.use(program)) return false
        val gl = core.gl
        core.bindTexture(UNIT_CHART8, chart8); core.bindTexture(UNIT_CHART16, chart16); core.bindTexture(UNIT_DEEDS, deeds)
        core.bindTexture(UNIT_FIELDS_A, fieldsA); core.bindTexture(UNIT_FAR, far)
        gl.uniform1i(program.uniform(core, "uChart8"), UNIT_CHART8); gl.uniform1i(program.uniform(core, "uChart16"), UNIT_CHART16)
        gl.uniform1i(program.uniform(core, "uDeeds"), UNIT_DEEDS); gl.uniform1i(program.uniform(core, "uFieldsA"), UNIT_FIELDS_A)
        gl.uniform1i(program.uniform(core, "uFar"), UNIT_FAR)
        gl.uniform3f(program.uniform(core, "uSeaFar"), sea[0], sea[1], sea[2])
        gl.uniform1f(program.uniform(core, "uAlpha"), alpha.toFloat())
        return true
    }

    /**
     * The chart pass over the bound target: opaque as the bottom layer ([alpha] 1: blend off), or blended over it under a
     * band fade (ground.js draws the chart with `uAlpha` then). Depth test off. False when nothing was drawn.
     */
    fun draw(core: Gl3Core, program: Gl3Program, chart8: Gl3Texture, chart16: Gl3Texture, deeds: Gl3Texture, fieldsA: Gl3Texture,
             far: Gl3Texture, sea: FloatArray, alpha: Double = 1.0): Boolean {
        if (!chart8.ready || !chart16.ready || !deeds.ready || !fieldsA.ready || !far.ready) return false
        core.disable(GL20.GL_DEPTH_TEST)
        if (alpha >= 1.0) core.disable(GL20.GL_BLEND)
        else { core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA) }
        if (!bind(core, program, chart8, chart16, deeds, fieldsA, far, sea, alpha)) return false
        core.fullscreen()
        if (alpha < 1.0) core.disable(GL20.GL_BLEND)
        return true
    }
}
