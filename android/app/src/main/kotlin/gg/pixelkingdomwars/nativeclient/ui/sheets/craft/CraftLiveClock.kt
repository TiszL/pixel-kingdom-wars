package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import android.os.SystemClock
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import kotlinx.coroutines.delay

/*
 * The craft sheets' living clock (craft/SPEC.md §2.3 "Timer source": left = server readyAt − the server-offset clock; at
 * 0 the card shows "Checking…", then refreshes; never "Done" before the server says so).
 *
 * The REFINE owner's protocol carries the server's snapshot instant but no receive-time offset, so its bench used to be
 * frozen at that instant until the player reopened the sheet. [snapshotClock] advances the snapshot by the device's
 * MONOTONIC time since this client first drew that snapshot. That first draw is never earlier than the server answer, so
 * the clock runs slightly behind the server and a countdown can only read longer than the truth, never shorter: it can
 * never claim a job is due early. [DueRefreshEffect] then asks the owner for one ordinary read once the job is due, so the
 * server's own completion (and the BATCH DONE celebration it proves) arrives without a reopen.
 */

/** Pure: the server time [elapsedNowMs] − [elapsedAtSnapshotMs] after the snapshot instant [snapshotMs]; null stays null
 *  (no server time observed). A monotonic step backwards is clamped to the snapshot itself. */
fun snapshotServerNow(snapshotMs: Long?, elapsedAtSnapshotMs: Long, elapsedNowMs: Long): Long? =
    snapshotMs?.let { it + (elapsedNowMs - elapsedAtSnapshotMs).coerceAtLeast(0L) }

/**
 * A clock for a sheet's countdowns that starts at the server snapshot [snapshotMs] and ticks with the device's monotonic
 * clock from the moment this [snapshot] object was first drawn. Null [snapshotMs] reads 0 (every countdown "…"/frozen,
 * as before). A new snapshot object (a fresh server read) re-anchors it.
 */
@Composable fun snapshotClock(snapshot: Any?, snapshotMs: Long?): () -> Long {
    val anchor = remember(snapshot) { SystemClock.elapsedRealtime() }
    return remember(snapshot, snapshotMs, anchor) {
        { snapshotServerNow(snapshotMs, anchor, SystemClock.elapsedRealtime()) ?: 0L }
    }
}

/** How long to wait after a job is due before read number [attempt] (0-based): 1.5 s, 3 s, 6 s, 12 s, then stop. */
fun dueRefreshDelayMs(dueInMs: Long, attempt: Int): Long = dueInMs.coerceAtLeast(0L) + 1_500L * (1L shl attempt.coerceIn(0, 3))

/** The number of due reads one job gets before the sheet waits for the next ordinary read (foreground, Retry, reopen). */
const val DUE_REFRESH_ATTEMPTS = 4

/**
 * Once the job [jobKey] is due ([readyAtMs] on the clock [serverNow]), asks [refresh] for one ordinary owner read, then
 * backs off ([dueRefreshDelayMs]) while the server still reports it running. [refresh] returns false when the owner cannot
 * read now (a review is open, the sheet is not current); that try is not counted and is retried 2 s later. Nothing here
 * delivers, collects, archives or celebrates: only the owner's own read can observe a finished job.
 */
@Composable fun DueRefreshEffect(jobKey: Any?, readyAtMs: Long?, serverNow: () -> Long, refresh: () -> Boolean) {
    val now by rememberUpdatedState(serverNow)
    val read by rememberUpdatedState(refresh)
    LaunchedEffect(jobKey, readyAtMs) {
        if (jobKey == null || readyAtMs == null) return@LaunchedEffect
        var attempt = 0
        var waits = 0
        while (attempt < DUE_REFRESH_ATTEMPTS && waits < 60) {
            val clock = now()
            if (clock <= 0L) return@LaunchedEffect
            delay(dueRefreshDelayMs(readyAtMs - clock, attempt))
            if (read()) attempt++ else { waits++; delay(2_000L) }
        }
    }
}
