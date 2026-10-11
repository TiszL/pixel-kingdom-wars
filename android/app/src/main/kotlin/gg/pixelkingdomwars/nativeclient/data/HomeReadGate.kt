package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline
import gg.pixelkingdomwars.nativeclient.network.homeCriticalRead
import okhttp3.Interceptor
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The longest an optional read waits for the Home read after sign-in. A bound, not a schedule: the Home read releases it. */
internal const val HOME_FIRST_HOLD_MS = 3_000L

/**
 * Cold-start measurement 2026-10-06 (demo build, QA chain lane): the Home's GET /base answered 14.5 s after Home composed. At
 * sign-in every Home surface starts its own read at once (starter fleet, vehicles, auctions, faucet, quests, Phase E
 * content…). They queued GET /base behind them, and on the lane GET /starter-fleet and GET /base also collide in the server's
 * berth hook (503 VEHICLE_BERTH_VIEW_HELD). Home's own reads go first: from sign-in until the first Home read has answered
 * (or [holdMs] has passed), an optional GET waits before it is sent. The Home and sign-in reads ([homeCriticalRead]),
 * every write and every event stream pass at once; nothing is dropped or reordered beyond that wait.
 */
internal class HomeReadGate(private val clock: () -> Long?, private val holdMs: Long = HOME_FIRST_HOLD_MS) {
    @Volatile private var latch: CountDownLatch? = null
    @Volatile private var deadlineMs = 0L

    /** Sign-in completed (AccountRepository): hold optional reads until the Home read answers. No clock (JVM tests): no hold. */
    fun arm() { val now = clock() ?: return; deadlineMs = now + holdMs; latch = CountDownLatch(1) }
    /** The first Home read answered, or failed: optional reads go. Idempotent. */
    fun release() { latch?.countDown(); latch = null }
    val holding: Boolean get() { val now = clock() ?: return false; return latch != null && now < deadlineMs }

    /** Whether a request waits for the Home read: an optional GET, never a Home/sign-in read, a write or an event stream. */
    fun holds(method: String, encodedPath: String, accept: String?): Boolean =
        method == "GET" && !homeCriticalRead(encodedPath) && accept != "text/event-stream"

    /** Blocks the calling OkHttp thread while armed, at most until the bound. */
    fun await() {
        val gate = latch ?: return
        val left = deadlineMs - (clock() ?: return)
        if (left > 0) gate.await(left, TimeUnit.MILLISECONDS)
    }

    val interceptor = Interceptor { chain ->
        val request = chain.request()
        if (holds(request.method, request.url.encodedPath, request.header("Accept"))) await()
        chain.proceed(request)
    }

    companion object {
        /** The process's gate: armed by sign-in, released by readHome, applied by the game API's transport. */
        val current = HomeReadGate(BootTimeline::clock)
    }
}
