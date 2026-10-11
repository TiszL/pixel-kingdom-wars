package gg.pixelkingdomwars.nativeclient.data

import java.math.BigInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * 2026-10-10 release lint (NewApi): BigInteger.longValueExact()/intValueExact() are API 31 and D8 does not backport them,
 * so the Market, Workshop and vehicle-craft money mappers threw NoSuchMethodError on Android 9-11 (minSdk 28). The compat
 * helpers that replace them must keep the API-31 contract exactly: the exact value, or ArithmeticException. A silent
 * truncation would show or submit a different price, so every out-of-range case below must throw.
 */
class ExactBigIntegerTest {
    private fun big(value: String) = BigInteger(value)
    private val longMax = BigInteger.valueOf(Long.MAX_VALUE)
    private val longMin = BigInteger.valueOf(Long.MIN_VALUE)
    private val intMax = BigInteger.valueOf(Int.MAX_VALUE.toLong())
    private val intMin = BigInteger.valueOf(Int.MIN_VALUE.toLong())

    @Test fun `in-range values convert exactly, both bounds included`() {
        assertEquals(0L, BigInteger.ZERO.longValueExactCompat())
        assertEquals(1_500_000_000L, big("1500000000").longValueExactCompat())
        assertEquals(Long.MAX_VALUE, longMax.longValueExactCompat())
        assertEquals(10_000, big("10000").intValueExactCompat())
        assertEquals(Int.MAX_VALUE, intMax.intValueExactCompat())
    }

    @Test fun `out-of-range values throw instead of truncating`() {
        // A u64 lamport/base-unit field at its maximum: toLong() would wrap it to -1.
        assertThrows(ArithmeticException::class.java) { big("18446744073709551615").longValueExactCompat() }
        assertThrows(ArithmeticException::class.java) { longMax.add(BigInteger.ONE).longValueExactCompat() }
        assertThrows(ArithmeticException::class.java) { big("1" + "0".repeat(40)).longValueExactCompat() }
        // 2^32 + 5: toInt() would wrap it to 5 basis points.
        assertThrows(ArithmeticException::class.java) { big("4294967301").intValueExactCompat() }
        assertThrows(ArithmeticException::class.java) { intMax.add(BigInteger.ONE).intValueExactCompat() }
    }

    @Test fun `negative values convert exactly down to the minimum and throw below it`() {
        assertEquals(-1L, big("-1").longValueExactCompat())
        assertEquals(Long.MIN_VALUE, longMin.longValueExactCompat())
        assertThrows(ArithmeticException::class.java) { longMin.subtract(BigInteger.ONE).longValueExactCompat() }
        assertEquals(-1, big("-1").intValueExactCompat())
        assertEquals(Int.MIN_VALUE, intMin.intValueExactCompat())
        assertThrows(ArithmeticException::class.java) { intMin.subtract(BigInteger.ONE).intValueExactCompat() }
    }

    @Test fun `agrees with the JDK exact conversions on every boundary`() {
        // The unit-test JVM has the API-31 methods; the helpers must give the same value or the same exception.
        val samples = listOf(BigInteger.ZERO, BigInteger.ONE, big("-1"), intMax, intMin, intMax.add(BigInteger.ONE),
            intMin.subtract(BigInteger.ONE), longMax, longMin, longMax.add(BigInteger.ONE), longMin.subtract(BigInteger.ONE),
            big("18446744073709551615"), big("-18446744073709551616"))
        for (value in samples) {
            assertEquals("long $value", runCatching { value.longValueExact() }.toOutcome(), runCatching { value.longValueExactCompat() }.toOutcome())
            assertEquals("int $value", runCatching { value.intValueExact() }.toOutcome(), runCatching { value.intValueExactCompat() }.toOutcome())
        }
    }

    private fun Result<Number>.toOutcome(): String = fold({ "value $it" }, { "throws ${it::class.java.name}" })
}
