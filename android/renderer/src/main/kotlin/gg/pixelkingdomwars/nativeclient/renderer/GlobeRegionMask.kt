package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.graphics.Pixmap

/** The shader reads region from red, deed eligibility from green and island chain
 * from alpha. Authored RGB PNGs cannot retain that last channel in their own format. */
fun globeRegionMask(regions: Pixmap, surface: Pixmap): Pixmap {
    require(regions.width == surface.width && regions.height == surface.height)
    val combined = Pixmap(surface.width, surface.height, Pixmap.Format.RGBA8888)
    try {
        combined.setBlending(Pixmap.Blending.None)
        for (y in 0 until surface.height) for (x in 0 until surface.width) {
            val code = surface.getPixel(x, y)
            combined.drawPixel(x, y, (regions.getPixel(x, y) and 0xff000000.toInt()) or
                (code and 0x00ff0000) or ((code ushr 8) and 255))
        }
        return combined
    } catch (error: Exception) { combined.dispose(); throw error }
}
