package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldShaders
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import java.nio.ByteBuffer

/** Fills one mip level of a fresh texture into [out] (position 0, exactly width × height × bytes per texel). Runs on a
 *  decode thread (`:app`'s `StagingUploader` calls it), never the GL thread. */
fun interface RealmPixelFill { fun fill(level: Int, width: Int, height: Int, out: ByteBuffer) }

/**
 * Never-sampled textures, created and filled off the GL thread (GLOBE-NATIVE-PLAN §5.7): `:app` implements this over
 * `StagingUploader.fresh` (the GL thread only reserves allocator room; the worker creates the immutable storage,
 * fills every level, fences; `poll` adopts it). Null when the pool refused room or the uploader is gone.
 */
interface RealmUploads {
    fun fresh(core: Gl3Core, pool: Gl3Pool, width: Int, height: Int, format: Gl3Format, levels: Int,
              sampling: Gl3Sampling, wrap: Gl3Wrap, fill: RealmPixelFill): Gl3Texture?
}

/** A program's two stages, fully preprocessed (read on a worker: [WorldShaders.source] reads the APK). */
class RealmProgramSource(val name: String, val vs: String, val fs: String, val vsSha256: String?, val fsSha256: String?)

/**
 * The core's programs and where their sources come from. Every realm-map stage is the pinned web string exported by
 * `tools/world-shaders.mjs` ([WorldShaders]); the only native GLSL is [FADE_BODY], the dive/leave cross-fade
 * composite, which the web does with CSS opacity, and [SELECT_BODY], the selected open deed's box, which the web draws as a
 * DOM box ([RealmSelectBox]). Their stages are the pinned blit's own preamble (`#version`, precision, `#define REALM_FS`)
 * plus that body, so they compile under exactly the web's header.
 */
object RealmPrograms {
    /**
     * The core's FAR ground: GROUND's `rm-chart` (chart.glsl.js), the painted chart in the realm's own sea ([RealmChart]).
     * It replaced SHELL's `stub-ground` stand-in (map.js `stubGround`), whose chart ended in a hard rectangle on a fixed
     * navy outside the grid: the owner's "cut picture" when zooming out (2026-09-25). Occupancy is drawn by
     * `minimap-dots` on the main view until a bases lane draws it.
     */
    const val OVERVIEW = "rm-chart"
    /** SHELL's retired stand-in: still exported and pin-checked, never drawn by the native engine. */
    const val RETIRED_STUB = "stub-ground"
    /** core.js `lowres` up-scale of the k× ground target. */
    const val BLIT = "rm-lowres-blit"
    const val MINIMAP = "minimap"
    const val MINIMAP_DOTS = "minimap-dots"
    /** Native only: the snapshot cross-fade (plan §3.5). */
    const val FADE = "world-fade"
    /** Native only: the selected open deed's box (ui.js `.rmx-selbox`, [RealmSelectBox]). */
    const val SELECT = "world-select"

    /** The exported programs the core draws with, in rehearsal order of need. */
    val EXPORTED: List<String> = listOf(OVERVIEW, BLIT, MINIMAP, MINIMAP_DOTS)

    const val FADE_BODY = "uniform sampler2D uSnap;\nuniform float uAlpha;\nout vec4 o;\n" +
        "void main() { o = vec4(texelFetch(uSnap, ivec2(gl_FragCoord.xy), 0).rgb, uAlpha); }\n"
    /** The box as ui.js draws it, per fragment: [d] = target px inside the border's outer edge `uBox`; the 2 px dark ring
     *  outside it, the 3 px gold border, the 1 px dark line inside it, then the gold tint `uLook.w`; × the pulse `uAlpha`. */
    const val SELECT_BODY = "uniform vec4 uBox;\nuniform vec4 uLook;\nuniform float uAlpha;\nout vec4 o;\n" +
        "void main() {\n" +
        "  vec2 p = gl_FragCoord.xy;\n" +
        "  float d = min(min(p.x - uBox.x, uBox.z - p.x), min(p.y - uBox.y, uBox.w - p.y));\n" +
        "  vec4 c = d < -uLook.x ? vec4(0.0) : (d < 0.0 || (d >= uLook.y && d < uLook.y + uLook.z)) ? vec4(0.043, 0.039, 0.063, 1.0)\n" +
        "    : vec4(0.957, 0.843, 0.482, d < uLook.y ? 1.0 : uLook.w);\n" +
        "  o = vec4(c.rgb, c.a * uAlpha);\n" +
        "}\n"
    private const val FS_MARK = "#define REALM_FS 1\n"

    /** The fade's fragment stage: the pinned blit FS up to and including its `#define REALM_FS 1` line, then [FADE_BODY]. */
    fun fadeFs(blitFs: String): String = blitPreamble(blitFs) + FADE_BODY

    /** The selected open deed box's fragment stage: the same preamble, then [SELECT_BODY]. */
    fun selectFs(blitFs: String): String = blitPreamble(blitFs) + SELECT_BODY

    private fun blitPreamble(blitFs: String): String {
        val at = blitFs.indexOf(FS_MARK)
        require(at > 0 && blitFs.startsWith("#version 300 es\n")) { "The pinned blit stage has no web preamble" }
        return blitFs.substring(0, at + FS_MARK.length)
    }

    /** Read every N2 stage (worker thread): the exported ones sha-checked by [WorldShaders.source]. */
    fun load(read: (WorldShaders.Stage) -> String = WorldShaders::source): Map<String, RealmProgramSource> {
        val out = LinkedHashMap<String, RealmProgramSource>()
        for (name in EXPORTED) {
            val p = WorldShaders.realm[name] ?: error("world shader table has no $name")
            out[name] = RealmProgramSource(name, read(p.vs), read(p.fs), p.vs.sha256, p.fs.sha256)
        }
        val blit = out.getValue(BLIT)
        out[FADE] = RealmProgramSource(FADE, blit.vs, fadeFs(blit.fs), blit.vsSha256, null)
        out[SELECT] = RealmProgramSource(SELECT, blit.vs, selectFs(blit.fs), blit.vsSha256, null)
        return out
    }
}

/** The core's programs of one context generation, created on the GL thread from sources read on a worker. */
class RealmProgramSet(core: Gl3Core, sources: Map<String, RealmProgramSource>) {
    private fun make(core: Gl3Core, s: RealmProgramSource) = core.program(s.name, s.vs, s.fs, s.vsSha256, s.fsSha256)
    val overview: Gl3Program = make(core, sources.getValue(RealmPrograms.OVERVIEW))
    val blit: Gl3Program = make(core, sources.getValue(RealmPrograms.BLIT))
    val minimap: Gl3Program = make(core, sources.getValue(RealmPrograms.MINIMAP))
    val dots: Gl3Program = make(core, sources.getValue(RealmPrograms.MINIMAP_DOTS))
    val fade: Gl3Program = make(core, sources.getValue(RealmPrograms.FADE))
    val select: Gl3Program = make(core, sources.getValue(RealmPrograms.SELECT))
    val all: Array<Gl3Program> = arrayOf(overview, blit, minimap, dots, fade, select)

    val ready: Boolean get() = all.all { it.ready }
    val failed: Gl3Program? get() = all.firstOrNull { it.state == Gl3Program.FAILED }
    val readyCount: Int get() = all.count { it.ready }
}
