package gg.pixelkingdomwars.nativeclient.wallet

import java.math.BigInteger

private val LONG_MIN: BigInteger = BigInteger.valueOf(Long.MIN_VALUE)
private val LONG_MAX: BigInteger = BigInteger.valueOf(Long.MAX_VALUE)

/**
 * [BigInteger.longValueExact] for minSdk 28. That method is API 31 and D8 does not backport it, so on Android 9-11 it
 * throws NoSuchMethodError inside the charter signing paths. Same contract: the exact value, or ArithmeticException
 * when it does not fit (a u64 above Long.MAX_VALUE is refused, never wrapped negative).
 */
internal fun BigInteger.longValueExactCompat(): Long {
    if (this < LONG_MIN || this > LONG_MAX) throw ArithmeticException("BigInteger out of long range")
    return toLong()
}
