package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** The one post-acceptance Home HUD refresh for every KEEP / Shards mutation made outside the base repository.
 *
 * The Home SHARDS and KEEP chips render `BaseState.balances`. KEEP→Shards conversion, Forge contribution, a
 * withdrawal request or unwind, a KEEP deposit credit and a mail reward claim each re-read `/balances` only into
 * their own screen's state, so the chips kept the old amount until the next Kingdom tick or a relaunch (owner
 * 2026-09-18). AppGraph appends this hook to the hydration of each of those flows, with the same `base.refresh()`
 * the army, battle and paid-base repositories already use.
 *
 * It runs inside a money operation's hydration, which retires a proven intent only after it returns, so it must
 * not turn a finished mutation into an "interrupted" one: a failed Home read is left to the repository's own
 * error state and the next tick. Real cancellation and a revoked session still propagate; a Home read that was
 * merely superseded (it reports that as a CancellationException) is not the caller's cancellation. */
internal fun homeHudRefresh(refreshHome: suspend () -> Unit): suspend () -> Unit = {
    try { refreshHome() }
    catch (superseded: CancellationException) { currentCoroutineContext().ensureActive() }
    catch (error: Exception) { if (error is ApiException && error.status == 401) throw error }
}
