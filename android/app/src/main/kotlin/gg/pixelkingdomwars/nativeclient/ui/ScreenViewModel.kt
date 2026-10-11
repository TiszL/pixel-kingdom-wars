package gg.pixelkingdomwars.nativeclient.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.ApiRouting
import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import gg.pixelkingdomwars.nativeclient.ops.Receipt
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class ScreenNotice(val message: String, val error: Boolean)

/** Common screen plumbing: one in-flight action per screen, errors turned into a notice, and the
 * session-scoped interrupted-request actions every money screen offers. */
abstract class ScreenViewModel : ViewModel() {
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()
    private val _notice = MutableStateFlow<ScreenNotice?>(null)
    val notice: StateFlow<ScreenNotice?> = _notice.asStateFlow()
    private var current: Job? = null
    /** True while [current] is a background read started by [runQuietly]: it is not an action, and the next action
     * cancels it instead of being dropped behind it. */
    private var currentQuiet = false
    /** True while this screen's single action is running (state edits that must not race it check this). A background
     * read ([runQuietly]) is not an action. */
    protected val active: Boolean get() = current?.isActive == true && !currentQuiet

    fun dismissNotice() { _notice.value = null }
    protected fun notify(message: String, error: Boolean = false) { _notice.value = ScreenNotice(message, error) }
    /** A confirmation that only announces (web `toast()`): it rides the app-wide [Toasts] host and retires itself. */
    protected fun toast(message: String, error: Boolean = false) { Toasts.post(message, error) }

    /** Drops a new action while one is active (a double tap must never double-submit). A running background read
     * ([runQuietly]) is cancelled instead: the action re-reads what it changes, and the tap is never lost. */
    protected fun run(block: suspend () -> Unit): Job? = launchSlot(quiet = false, block)

    /** A routine background read (the Home cadence tick, owner 2026-10-06 "always loading"). It holds the same single
     * slot, so it never overlaps an action or a receipt check, but it raises no [busy], keeps the notice, is skipped
     * while anything runs, and yields to the next action. Its failure stays in its repository's own state (the last
     * good data remains shown); no screen notice is added. */
    protected fun runQuietly(block: suspend () -> Unit): Job? = launchSlot(quiet = true, block)

    private fun launchSlot(quiet: Boolean, block: suspend () -> Unit): Job? {
        current?.takeIf { it.isActive }?.let { running ->
            if (quiet || !currentQuiet) return null
            running.cancel()
        }
        currentQuiet = quiet
        val job = viewModelScope.launch {
            if (!quiet) { _busy.value = true; _notice.value = null }
            try { block() }
            catch (error: SessionSupersededException) { /* The account changed; the shell routes away. */ }
            catch (error: CancellationException) { throw error }
            // The land gate and the funds sheet already explain their refusals (web `actionError.ts`); no second notice.
            catch (error: Exception) {
                // Expected validation, wallet refusals and connectivity notices are not reliability incidents.
                if (error is NullPointerException || error is IndexOutOfBoundsException || error is ClassCastException || error is kotlinx.serialization.SerializationException)
                    gg.pixelkingdomwars.nativeclient.telemetry.NativeTelemetryRuntime.record(gg.pixelkingdomwars.nativeclient.telemetry.NativeError.SCREEN, error)
                if (!quiet && !ApiRouting.handledGlobally(error)) _notice.value = ScreenNotice(error.message ?: "Connection interrupted. Please retry.", error = true)
            }
            finally { if (!quiet) _busy.value = false }
        }
        current = job
        return job
    }

    protected fun interruptedActions(graph: SessionGraph) = InterruptedActions(
        check = { kind -> run { report(graph.observer.check(kind, graph.session.wallet)) } },
        close = { kind -> run { report(graph.observer.close(kind, graph.session.wallet)) } },
        retry = { kind -> run { report(graph.observer.retry(kind, graph.session.wallet)) } },
    )
    private fun report(receipt: Receipt<*>?) { Copy.observation(receipt)?.let { notify(it) } }
}

class InterruptedActions(val check: (String) -> Unit, val close: (String) -> Unit, val retry: (String) -> Unit)
