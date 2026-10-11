package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import java.nio.ByteBuffer

/**
 * The GLES 3 integer uniform setters the LIFE and BASES programs need that [gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3]
 * does not carry yet (`glUniform1ui`, `glUniform2i`, `glUniform4i`, `glUniform4iv`: the scatter windows are `ivec4[8]`,
 * the puff life a `uint`). The lead adds them to `Gl3` (+ `AndroidGl3`, `FakeGl3`); until then a `Gl3` that also
 * implements this interface enables LIFE, and one that does not makes the lane report it and draw nothing (never a
 * silently wrong uniform). Every method maps 1:1 to one GL call and never allocates.
 */
interface Gl3IntUniforms {
    fun uniform1ui(location: Int, v: Int)
    fun uniform2i(location: Int, x: Int, y: Int)
    fun uniform4i(location: Int, x: Int, y: Int, z: Int, w: Int)
    /** `glUniform4iv(location, count, v, offset)`: [count] ivec4s from [v] at [offset]. */
    fun uniform4iv(location: Int, count: Int, v: IntArray, offset: Int)
}

/** Fills one (layer, mip level) of a fresh array texture into [out] (position 0, exactly w × h × bytes per texel), on a
 *  decode thread (`:app`'s `StagingUploader` calls it), never the GL thread. */
fun interface LanePixelFill { fun fill(layer: Int, level: Int, width: Int, height: Int, out: ByteBuffer) }

/**
 * Never-sampled textures created and filled off the GL thread (GLOBE-NATIVE-PLAN §5.7): the GL thread only reserves
 * allocator room; the worker creates the immutable storage, fills every layer and level, and fences. `:app` implements it
 * over `StagingUploader.fresh(core, pool, array, w, h, layers, format, levels, sampling, wrap) { layer, level, w, h, out -> … }`.
 * Null when the pool refused room or the uploader is gone.
 */
interface LaneUploads {
    fun fresh(core: Gl3Core, pool: Gl3Pool, array: Boolean, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int,
              sampling: Gl3Sampling, wrap: Gl3Wrap, fill: LanePixelFill): Gl3Texture?
}

/**
 * What LIFE and BASES read from GROUND (web `ground.bindClasses`, `ground.classState`, contracts.js GROUND_API). NR's
 * ground lane implements it; the lead wires the instance.
 */
interface RealmClasses {
    /**
     * Bind GROUND's class inputs for [program] from texture unit [firstUnit] (`UNITS.classesFirst` = 8): the classes
     * include's samplers (`uRmBase`, `uRmLineTex`, `uRmPageTable`, `uRmLattice`, `uRmRecords`, `uRmFieldsA`) and its `uRm*`
     * uniforms. False when GROUND cannot yet (then LIFE draws nothing that frame: its placement would read no terrain).
     */
    fun bindClasses(program: Gl3Program, firstUnit: Int): Boolean
    /** GROUND's CPU class at a realm-local tile (classify.js `classAt` over its fields, rivers bent, bridges built), for
     *  BASES' paths over terrain; null until those inputs are loaded (then the paths wait, as on the web). */
    fun classAt(): ((Int, Int) -> Int)?
}
