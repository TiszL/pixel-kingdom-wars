package gg.pixelkingdomwars.nativeclient.network

/** `packages/shared/src/duration.ts` fmtDur (D-070): the two most significant non-zero units, seconds
 * only under an hour — "6d 2h · 2h 36m · 36m 5s · 45s · 0s". Whole seconds; a negative reads "0s". */
fun fmtDur(sec: Long): String {
    val total = maxOf(0L, sec)
    val d = total / 86_400; val h = total % 86_400 / 3_600; val m = total % 3_600 / 60; val s = total % 60
    return when {
        d > 0 -> if (h > 0) "${d}d ${h}h" else "${d}d"
        h > 0 -> if (m > 0) "${h}h ${m}m" else "${h}h"
        m > 0 -> if (s > 0) "${m}m ${s}s" else "${m}m"
        else -> "${s}s"
    }
}

/** `duration.ts` fmtClock: `hh:mm:ss` under a day, the fmtDur words from a day up. */
fun fmtClock(sec: Long): String {
    val total = maxOf(0L, sec)
    if (total >= 86_400) return fmtDur(total)
    return "%02d:%02d:%02d".format(total / 3_600, total % 3_600 / 60, total % 60)
}

/** `ui/primitives.tsx` fmtN: thousands separators on an integer decimal string (a fraction is
 * truncated like the web's `Math.trunc`); anything that is not a number reads "0". */
fun fmtN(value: String): String {
    val match = Regex("^(-?)0*(\\d+)(?:\\.\\d+)?$").find(value.trim()) ?: return "0"
    val digits = match.groupValues[2]
    val grouped = digits.reversed().chunked(3).joinToString(",").reversed()
    return if (grouped == "0") "0" else match.groupValues[1] + grouped
}
fun fmtN(value: Long): String = fmtN(value.toString())
