package gg.pixelkingdomwars.nativeclient

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalUiDeviceAdmissionTest {
    // Synthetic values only. SHA-256 of the exact UTF-8 MODEL|PRODUCT|FINGERPRINT
    // string, independently calculated while authoring; no device was contacted.
    private val model = "Synthetic Seeker"
    private val product = "synthetic_product"
    private val fingerprint = "synthetic/vendor/product:1/release:user/release-keys"
    private val proof = "baa99a259bd21f654108d4c638a619b217ffaf02a0fc110f4a0b5acc0c04703e"

    private fun permits(expected: String = proof, debug: Boolean = true,
                        hardware: String = "synthetic_hardware", model: String = this.model,
                        product: String = this.product, fingerprint: String = this.fingerprint) =
        LocalUiDeviceAdmission.permits(debug, hardware, expected, model, product, fingerprint)

    @Test fun `ranchu debug retains the emulator admission when the property is absent`() {
        assertTrue(permits(expected = "", hardware = "ranchu"))
    }

    @Test fun `absent property refuses physical hardware`() {
        assertFalse(permits(expected = ""))
    }

    @Test fun `matching test-only proof admits the exact physical build tuple`() {
        assertTrue(permits())
    }

    @Test fun `mismatching proof refuses physical hardware`() {
        assertFalse(permits(expected = "0".repeat(64)))
    }

    @Test fun `nondebug builds always refuse even emulator or matching proof`() {
        assertFalse(permits(debug = false))
        assertFalse(permits(expected = "", debug = false, hardware = "ranchu"))
    }

    @Test fun `every runtime identity field participates in the proof`() {
        assertFalse(permits(model = "$model changed"))
        assertFalse(permits(product = "$product changed"))
        assertFalse(permits(fingerprint = "$fingerprint changed"))
    }

    @Test fun `proof format is strict lowercase sha256 without normalization`() {
        for (bad in listOf(" ", "true", proof.uppercase(), proof.dropLast(1), "$proof\n", " $proof")) {
            assertFalse(permits(expected = bad))
        }
    }

    @Test fun `runtime fields are hashed exactly without trimming or changing case`() {
        assertFalse(permits(model = " $model"))
        assertFalse(permits(product = product.uppercase()))
        assertFalse(permits(fingerprint = "$fingerprint "))
    }

    @Test fun `empty fields and ambiguous delimiter or control characters refuse`() {
        for (bad in listOf("", " ", "model|product", "model\n", "model\r", "model\u0000")) {
            assertFalse(permits(model = bad))
            assertFalse(permits(product = bad))
            assertFalse(permits(fingerprint = bad))
        }
    }

    @Test fun `other emulator hardware strings do not broaden legacy admission`() {
        for (hardware in listOf("goldfish", "RANCHU", "ranchu ", "")) {
            assertFalse(permits(expected = "", hardware = hardware))
        }
    }
}
