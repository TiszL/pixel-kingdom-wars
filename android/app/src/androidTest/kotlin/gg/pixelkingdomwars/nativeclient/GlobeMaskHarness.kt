package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.os.Build
import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.utils.GdxNativesLoader
import gg.pixelkingdomwars.nativeclient.renderer.globeRegionMask

/** Actual Android Pixmap formats: RGB input must not turn every realm into an
 * exploration island by silently discarding the shader's zero alpha codes. */
object GlobeMaskHarness {
    fun verify(instrumentation: Instrumentation) {
        check(BuildConfig.DEBUG && Build.HARDWARE == "ranchu")
        GdxNativesLoader.load()
        val regions = Pixmap(3, 1, Pixmap.Format.RGB888)
        val surface = Pixmap(3, 1, Pixmap.Format.RGB888)
        try {
            regions.setBlending(Pixmap.Blending.None); surface.setBlending(Pixmap.Blending.None)
            regions.drawPixel(0, 0, 0x040000ff); surface.drawPixel(0, 0, 0x010100ff)
            regions.drawPixel(1, 0, 0x000000ff); surface.drawPixel(1, 0, 0x000000ff)
            regions.drawPixel(2, 0, 0x080000ff); surface.drawPixel(2, 0, 0x010003ff)
            val packed = globeRegionMask(regions, surface)
            try {
                check(packed.format == Pixmap.Format.RGBA8888)
                check(packed.getPixel(0, 0) == 0x04010000) { "Realm must retain region/eligibility and zero exploration code" }
                check(packed.getPixel(1, 0) == 0) { "Ocean must have no region, eligibility or exploration code" }
                check(packed.getPixel(2, 0) == 0x08000003) { "Island chain must retain its exact alpha code" }
                check(regions.getPixel(0, 0) == 0x040000ff && surface.getPixel(2, 0) == 0x010003ff)
            } finally { packed.dispose() }
            val wrongSize = Pixmap(1, 1, Pixmap.Format.RGB888)
            try { check(runCatching { globeRegionMask(regions, wrongSize) }.exceptionOrNull() is IllegalArgumentException) }
            finally { wrongSize.dispose() }
            java.io.File(instrumentation.targetContext.noBackupFilesDir, "globe-mask-regression.txt")
                .writeText("PASS: actual RGB input preserves realm/ocean/island shader codes in RGBA; source inputs unchanged; mismatched dimensions refused.\n")
        } finally { regions.dispose(); surface.dispose() }
    }
}
