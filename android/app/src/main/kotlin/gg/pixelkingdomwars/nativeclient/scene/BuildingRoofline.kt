package gg.pixelkingdomwars.nativeclient.scene

import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Rect
import android.os.Build
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.renderer.RenderBuilding
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/** Building cells are authored with transparent rows above the roof (a level 1 camp paints the lowest third of its
 * cell). World chrome that sits "above the building" needs the first painted row, which no catalogue states, so it is
 * read once per frame key from the admitted atlas. The ware idle clips share the static frame's cell and roofline. */
internal fun firstPaintedRow(pixels: IntArray, width: Int, height: Int, alphaFloor: Int = 16): Int? {
    require(width > 0 && height > 0 && pixels.size >= width * height)
    for (row in 0 until height) for (column in 0 until width) if (pixels[row * width + column] ushr 24 > alphaFloor) return row
    return null
}

/** The painted top of [building] in world pixels (y grows downward), seated exactly like the renderer's
 * `placeBuilding`: the cell bottom meets the footprint's south edge. */
internal fun roofWorldY(building: RenderBuilding, tilePixels: Float, scale: Float, offsetY: Float, cellHeight: Int, paintedRow: Int): Float =
    (building.tileY + building.footprintHeight) * tilePixels + offsetY - (cellHeight - paintedRow) * scale

internal object BuildingRooflines {
    private data class Roofline(val cellHeight: Int, val paintedRow: Int)
    private val measured = ConcurrentHashMap<String, Roofline>()

    /** Blocking file and bitmap work: call off Main. Null when the pack cannot answer; the caller then shows nothing. */
    fun measuredRoof(assets: File, render: JsonObject, building: RenderBuilding, tilePixels: Float): Float? = runCatching {
        val entry = render.getValue("entries").jsonArray.map { it.jsonObject }.first { it.string("frameKey") == building.frameKey }
        val atlas = requireNotNull(entry.string("atlasPath"))
        val roofline = measured.getOrPut("${assets.absolutePath}|$atlas|${building.frameKey}") { measure(assets, atlas, building.frameKey) }
        roofWorldY(building, tilePixels, requireNotNull(entry.string("scale")).toFloat(), entry.string("offsetY")?.toFloat() ?: 0f, roofline.cellHeight, roofline.paintedRow)
    }.getOrNull()

    private fun measure(assets: File, atlasPath: String, frameKey: String): Roofline {
        val root = assets.canonicalFile
        fun admitted(relative: String) = File(root, relative).canonicalFile.also { require(it.toPath().startsWith(root.toPath()) && it.isFile) }
        fun JsonObject.int(key: String) = requireNotNull(string(key)).toInt()
        val pages = Json.parseToJsonElement(admitted(atlasPath).readText()).jsonObject.getValue("textures").jsonArray.map { it.jsonObject }
        val (page, frame) = pages.firstNotNullOf { page -> page.getValue("frames").jsonArray.map { it.jsonObject }.firstOrNull { it.string("filename") == frameKey }?.let { page to it } }
        val bounds = frame.getValue("frame").jsonObject
        val image = requireNotNull(page.string("image")).also { require('/' !in it && '\\' !in it && it != "..") }
        val path = admitted(atlasPath.substringBeforeLast('/', "").let { if (it.isEmpty()) image else "$it/$image" }).absolutePath
        @Suppress("DEPRECATION") // API28–30 compatibility; the API31 overload removes only isShareable.
        val decoder = requireNotNull(if (Build.VERSION.SDK_INT >= 31) BitmapRegionDecoder.newInstance(path) else BitmapRegionDecoder.newInstance(path, false))
        try {
            val x = bounds.int("x"); val y = bounds.int("y"); val w = bounds.int("w"); val h = bounds.int("h")
            val bitmap = requireNotNull(decoder.decodeRegion(Rect(x, y, x + w, y + h), BitmapFactory.Options().apply { inScaled = false }))
            val pixels = IntArray(w * h).also { bitmap.getPixels(it, 0, w, 0, 0, w, h) }; bitmap.recycle()
            return Roofline(frame.getValue("sourceSize").jsonObject.int("h"), frame.getValue("spriteSourceSize").jsonObject.int("y") + (firstPaintedRow(pixels, w, h) ?: 0))
        } finally { decoder.recycle() }
    }
}
