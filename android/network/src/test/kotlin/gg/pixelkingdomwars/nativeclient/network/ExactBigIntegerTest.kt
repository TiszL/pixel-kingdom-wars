package gg.pixelkingdomwars.nativeclient.network

import java.io.File
import java.math.BigInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 2026-10-10 release lint (NewApi): BigInteger.longValueExact() is API 31 and D8 does not backport it, so ordinary
 * crafting's batch duration threw NoSuchMethodError on Android 8-11 (this module's minSdk is 26). The compat helper must
 * keep the API-31 contract exactly: the exact value, or ArithmeticException — never a wrapped duration.
 */
class ExactBigIntegerTest {
    private val longMax = BigInteger.valueOf(Long.MAX_VALUE)
    private val longMin = BigInteger.valueOf(Long.MIN_VALUE)

    @Test fun `in-range values convert exactly, both bounds included`() {
        assertEquals(0L, BigInteger.ZERO.longValueExactCompat())
        assertEquals(86_400L * 25, BigInteger.valueOf(86_400L * 25).longValueExactCompat())
        assertEquals(Long.MAX_VALUE, longMax.longValueExactCompat())
    }

    @Test fun `out-of-range values throw instead of truncating`() {
        assertThrows(ArithmeticException::class.java) { longMax.add(BigInteger.ONE).longValueExactCompat() }
        assertThrows(ArithmeticException::class.java) { BigInteger("18446744073709551615").longValueExactCompat() }
    }

    @Test fun `negative values convert exactly down to the minimum and throw below it`() {
        assertEquals(-1L, BigInteger("-1").longValueExactCompat())
        assertEquals(Long.MIN_VALUE, longMin.longValueExactCompat())
        assertThrows(ArithmeticException::class.java) { longMin.subtract(BigInteger.ONE).longValueExactCompat() }
    }

    @Test fun `agrees with the JDK exact conversion on every boundary`() {
        for (value in listOf(BigInteger.ZERO, BigInteger("-1"), longMax, longMin, longMax.add(BigInteger.ONE), longMin.subtract(BigInteger.ONE))) {
            val jdk = runCatching { value.longValueExact() }.fold({ "value $it" }, { "throws ${it::class.java.name}" })
            val compat = runCatching { value.longValueExactCompat() }.fold({ "value $it" }, { "throws ${it::class.java.name}" })
            assertEquals("$value", jdk, compat)
        }
    }

    @Test fun `no main source calls the API-31 exact conversions directly`() {
        // App lint does not analyse this module, so this scan is the guard against the crash coming back.
        val offenders = File("src/main/kotlin").walkTopDown().filter { it.isFile && it.extension == "kt" }
            .flatMap { file -> file.readLines().mapIndexedNotNull { i, line -> "${file.path}:${i + 1}".takeIf { Regex("""\.(long|int)ValueExact\(""").containsMatchIn(line) } } }
            .toList()
        assertTrue("use longValueExactCompat(): $offenders", offenders.isEmpty())
    }
}
