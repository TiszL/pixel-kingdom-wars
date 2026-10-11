package gg.pixelkingdomwars.nativeclient.data

import java.math.BigInteger

private val LONG_MIN: BigInteger = BigInteger.valueOf(Long.MIN_VALUE)
private val LONG_MAX: BigInteger = BigInteger.valueOf(Long.MAX_VALUE)
private val INT_MIN: BigInteger = BigInteger.valueOf(Int.MIN_VALUE.toLong())
private val INT_MAX: BigInteger = BigInteger.valueOf(Int.MAX_VALUE.toLong())

/**
 * [BigInteger.longValueExact] for minSdk 28. That method is API 31 and D8 does not backport it, so on Android 9-11 it
 * throws NoSuchMethodError (lint NewApi). Same contract: the exact value, or ArithmeticException when it does not fit.
 * Never truncates — callers pass money and identity values.
 */
internal fun BigInteger.longValueExactCompat(): Long {
    if (this < LONG_MIN || this > LONG_MAX) throw ArithmeticException("BigInteger out of long range")
    return toLong()
}

/** [BigInteger.intValueExact] (API 31) for minSdk 28; same contract as [longValueExactCompat]. */
internal fun BigInteger.intValueExactCompat(): Int {
    if (this < INT_MIN || this > INT_MAX) throw ArithmeticException("BigInteger out of int range")
    return toInt()
}
