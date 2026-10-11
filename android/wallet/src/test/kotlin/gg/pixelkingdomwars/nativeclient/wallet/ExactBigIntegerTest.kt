package gg.pixelkingdomwars.nativeclient.wallet

import java.io.File
import java.math.BigInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 2026-10-10 release lint (NewApi): BigInteger.longValueExact() is API 31 and D8 does not backport it, so the charter,
 * retirement and tournament preparations threw NoSuchMethodError on Android 9-11 (minSdk 28) while reading the candidate
 * blockhash slot and the observed timestamp. The compat helper must keep the API-31 contract exactly: a u64 above
 * Long.MAX_VALUE is refused with ArithmeticException, never wrapped into a negative slot.
 */
class ExactBigIntegerTest {
    private val longMax = BigInteger.valueOf(Long.MAX_VALUE)
    private val longMin = BigInteger.valueOf(Long.MIN_VALUE)

    @Test fun `in-range values convert exactly, both bounds included`() {
        assertEquals(0L, BigInteger.ZERO.longValueExactCompat())
        assertEquals(1_760_054_400L, cAmount("1760054400", 63).longValueExactCompat())
        assertEquals(Long.MAX_VALUE, cReadLe(byteArrayOf(-1, -1, -1, -1, -1, -1, -1, 0x7f)).longValueExactCompat())
    }

    @Test fun `out-of-range values throw instead of truncating`() {
        // Eight 0xff bytes read little-endian unsigned: 2^64-1, which toLong() would wrap to -1.
        assertThrows(ArithmeticException::class.java) { cReadLe(ByteArray(8) { -1 }).longValueExactCompat() }
        assertThrows(ArithmeticException::class.java) { longMax.add(BigInteger.ONE).longValueExactCompat() }
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
        // App lint does not analyse this module (signing paths), so this scan is the guard against the crash coming back.
        val offenders = File("src/main/kotlin").walkTopDown().filter { it.isFile && it.extension == "kt" }
            .flatMap { file -> file.readLines().mapIndexedNotNull { i, line -> "${file.path}:${i + 1}".takeIf { Regex("""\.(long|int)ValueExact\(""").containsMatchIn(line) } } }
            .toList()
        assertTrue("use longValueExactCompat(): $offenders", offenders.isEmpty())
    }
}
