package gg.pixelkingdomwars.nativeclient.ui.sheets

import org.junit.Assert.assertFalse
import org.junit.Test

/** APK001 compiled successfully but R8 rejected an unlowered return marker in this class. */
class SheetHostBytecodeTest {
    // WHY: source compilation alone does not guarantee that this Compose host is valid input to dex.
    @Test fun `compiled sheet host contains no non local return marker rejected by R8`() {
        val bytes = requireNotNull(javaClass.getResourceAsStream("SheetHostKt.class")) {
            "The compiled production SheetHostKt class must be present on the test classpath."
        }.use { it.readBytes() }
        val marker = "\$\$\$\$\$NON_LOCAL_RETURN\$\$\$\$\$"
        assertFalse("SheetHost must not retain the invalid Kotlin return marker rejected by APK001 R8.",
            bytes.toString(Charsets.ISO_8859_1).contains(marker))
    }
}
