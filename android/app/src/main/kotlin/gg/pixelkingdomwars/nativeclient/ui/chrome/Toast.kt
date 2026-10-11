package gg.pixelkingdomwars.nativeclient.ui.chrome

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** One transient line (web `toast()` in ui/toast.ts): it announces, it never asks, and it never blocks. [go] is the
 *  optional place its blue GO opens (hub SPEC §3.2); the layer draws GO only while a GO door is bound ([ToastDoors]). */
data class ToastItem(val id: Long, val message: String, val error: Boolean, val postedAt: Long, val go: FeatureId? = null,
    /** Bumped by every merge, so the plate's own fade restarts with the queue's clock. */
    val revision: Int = 0)

/** Pure queue the host drives with its own clock, so timing is testable: a toast lives [lifetimeMs] from its
 * post, a tap retires it early, and at most [maxVisible] stack (oldest dropped first) so a burst cannot wall
 * the screen. Nothing here is a game number; the web toast lives 4 s as well. */
class ToastQueue(val lifetimeMs: Long = 4_000, val maxVisible: Int = 3) {
    private val mutable = MutableStateFlow<List<ToastItem>>(emptyList())
    val items: StateFlow<List<ToastItem>> = mutable.asStateFlow()
    private var nextId = 1L

    /** Hub SPEC §3.2: "the same key merges and restarts the timer". The same line posted again (a door tapped twice, a
     *  read failing on every poll) keeps its id, so the plate stays put instead of stacking copies, moves to the bottom
     *  (newest) and lives a full lifetime from [now]. */
    @Synchronized fun post(message: String, error: Boolean = false, now: Long, go: FeatureId? = null): ToastItem {
        val same = mutable.value.firstOrNull { it.message == message && it.error == error && it.go == go }
        val item = same?.copy(postedAt = now, revision = same.revision + 1) ?: ToastItem(nextId++, message, error, now, go)
        mutable.update { list -> (list.filter { it.id != item.id } + item).takeLast(maxVisible) }
        return item
    }
    fun dismiss(id: Long) = mutable.update { list -> list.filter { it.id != id } }
    /** Drops every expired toast and returns the delay until the next expiry, or null when nothing is queued. */
    fun expire(now: Long): Long? {
        mutable.update { list -> list.filter { it.postedAt + lifetimeMs > now } }
        return mutable.value.minOfOrNull { it.postedAt + lifetimeMs - now }
    }
}

/** The app-wide queue every screen model posts to; KitToastLayer (MainActivity) renders it. */
object Toasts {
    val queue = ToastQueue()
    fun post(message: String, error: Boolean = false, go: FeatureId? = null) = queue.post(message, error, System.currentTimeMillis(), go)
}
