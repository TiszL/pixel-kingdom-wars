package gg.pixelkingdomwars.nativeclient

import java.time.Instant

/** A timer is presentation only. Even at zero, the server still owns the job. */
internal data class BaseJobProgress(val remaining: String, val fraction: Float)
internal fun baseJobProgress(start: String?, end: String?, now: Long): BaseJobProgress? = runCatching {
    val started = Instant.parse(requireNotNull(start)).toEpochMilli()
    val finished = Instant.parse(requireNotNull(end)).toEpochMilli()
    require(finished >= started)
    val seconds = kotlin.math.ceil((finished.toDouble()-now)/1000).toLong().coerceAtLeast(0)
    val label = when {
        seconds == 0L -> "Finishing…"
        seconds >= 86_400 -> "${seconds/86_400}d ${(seconds%86_400)/3600}h remaining"
        seconds >= 3600 -> "${seconds/3600}h ${(seconds%3600)/60}m remaining"
        seconds >= 60 -> "${seconds/60}m ${seconds%60}s remaining"
        else -> "${seconds}s remaining"
    }
    val duration = finished.toDouble()-started
    BaseJobProgress(label,if(duration==0.0) (if(now >= finished) 1f else 0f)
        else ((now.toDouble()-started)/duration).coerceIn(0.0,1.0).toFloat())
}.getOrNull()
