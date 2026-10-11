package gg.pixelkingdomwars.nativeclient.scene

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.os.Looper
import gg.pixelkingdomwars.nativeclient.renderer.LayeredImageDecoder
import gg.pixelkingdomwars.nativeclient.renderer.LayeredRgba

/** Android's WebP codec runs only on the presentation worker. Copying ARGB
 * integers explicitly avoids treating native-endian/premultiplied bitmap memory
 * as the straight RGBA that libGDX texture uploads expect. */
object AndroidLayeredImageDecoder : LayeredImageDecoder {
    override fun decode(encoded: ByteArray, width: Int, height: Int): LayeredRgba {
        check(Looper.myLooper() != Looper.getMainLooper()) { "Layered artwork cannot decode on Main" }
        require(width in 1..2048 && height in 1..2048 && encoded.size <= 2 * 1024 * 1024)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(encoded, 0, encoded.size, bounds)
        require(bounds.outWidth == width && bounds.outHeight == height) { "Layered artwork dimensions changed" }
        val options = BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
            inPremultiplied = false; inScaled = false
        }
        val bitmap = requireNotNull(BitmapFactory.decodeByteArray(encoded, 0, encoded.size, options)) { "Layered artwork could not decode" }
        return try {
            require(bitmap.width == width && bitmap.height == height && !bitmap.isPremultiplied) { "Layered decoder did not return straight pixels" }
            val rgba = ByteArray(width * height * 4); val row = IntArray(width)
            for (y in 0 until height) {
                bitmap.getPixels(row, 0, width, 0, y, width, 1)
                for (x in 0 until width) {
                    val p = row[x]; val at = (y * width + x) * 4
                    rgba[at] = (p ushr 16).toByte(); rgba[at + 1] = (p ushr 8).toByte()
                    rgba[at + 2] = p.toByte(); rgba[at + 3] = (p ushr 24).toByte()
                }
            }
            LayeredRgba(width, height, rgba)
        } finally { bitmap.recycle() }
    }
}
