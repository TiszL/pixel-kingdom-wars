package gg.pixelkingdomwars.nativeclient.renderer.globe2

import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldShaders
import gg.pixelkingdomwars.nativeclient.renderer.world.InputScale

/**
 * Ready-made adapters for the host (lane NG), so wiring the flat globe is a few lines in `:app`:
 * - [WorldShadersGlobeSource]: the pinned stages from NT's generated `WorldShaders` (classpath resources, each checked
 *   against its sha256): the globe's own programs, and the realm engine's `rm-lowres-blit` for the half-scale step.
 *   Null for a program the pin does not carry, which the renderer reports as `unavailable` (or, for the blit, runs
 *   without the half-scale step).
 * - [GdxGlobeFiles]: a [GlobeFiles] over a libGDX [FileHandle] (internal assets for the debug `world/` bundle, or the
 *   active content directory for the client pack), with the sha256 index of `world/content.json` when given one.
 * - [globeLayoutFromView]: the HUD bridge's layout (VIEW px, x/y/w/h) as the engine's [GlobeLayout] (BUFFER px, x0/y0/x1/y1).
 */
object WorldShadersGlobeSource : GlobeShaderSource {
    override fun stages(name: String): GlobeStages? {
        val p = WorldShaders.globe[name] ?: WorldShaders.realm[name]?.takeIf { name == GlobeV2Renderer.PROGRAM_BLIT } ?: return null
        return GlobeStages(WorldShaders.source(p.vs), WorldShaders.source(p.fs), p.vs.sha256, p.fs.sha256)
    }
}

/** Files under [root]; [sha] maps a root-relative path to the sha256 its manifest pins (null = no outer manifest). */
class GdxGlobeFiles(private val root: FileHandle, private val sha: Map<String, String>?) : GlobeFiles {
    override fun read(path: String): ByteArray? {
        val f = root.child(path)
        return if (f.exists()) f.readBytes() else null
    }
    override fun expectedSha256(path: String): String? = sha?.get(path)

    companion object {
        /**
         * The debug world bundle: [world] is `world/` (NT's `tools/world-debug-content.mjs`), whose `content.json` lists
         * `{ files: [{ path, sha256, bytes }] }` with paths relative to `world/`. Null when the bundle is absent (release
         * builds carry none): the host then keeps the legacy globe.
         */
        fun worldBundle(world: FileHandle): GdxGlobeFiles? {
            val manifest = world.child("content.json")
            if (!manifest.exists()) return null
            val files = JsonReader().parse(manifest.readString("UTF-8")).get("files") ?: return null
            val index = HashMap<String, String>()
            for (f in files) index[f.getString("path")] = f.getString("sha256")
            return GdxGlobeFiles(world, index)
        }
    }
}

/**
 * The HUD bridge's globe framing (VIEW px: the header's bottom, obstacles and the free rect as x, y, w, h) converted
 * into the engine's [GlobeLayout] (BUFFER px, x0, y0, x1, y1) through [input].
 */
fun globeLayoutFromView(headerBottom: Float, obstacles: FloatArray, count: Int, panelFree: FloatArray?, input: InputScale): GlobeLayout {
    fun rect(src: FloatArray, at: Int, out: FloatArray, o: Int) {
        out[o] = input.viewToBufferX(src[at]); out[o + 1] = input.viewToBufferY(src[at + 1])
        out[o + 2] = input.viewToBufferX(src[at] + src[at + 2]); out[o + 3] = input.viewToBufferY(src[at + 1] + src[at + 3])
    }
    val obs = FloatArray(count * 4); for (i in 0 until count) rect(obstacles, i * 4, obs, i * 4)
    val free = panelFree?.let { FloatArray(4).also { out -> rect(it, 0, out, 0) } }
    return GlobeLayout(input.viewToBufferY(headerBottom), obs, count, free)
}
