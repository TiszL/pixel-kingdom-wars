package gg.pixelkingdomwars.nativeclient.data

import androidx.lifecycle.Lifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first

/** Backgrounding invalidates ordinary work. Only an explicitly opened wallet ceremony may
 * return across STOP; its proof cannot reach verification until this screen resumes. */
class SeekerInteraction {
    private val foreground = MutableStateFlow(false)
    private var generation = 0L
    private var walletOpen = false
    fun setForeground(value: Boolean) {
        if (foreground.value == value) return
        foreground.value = value
        if (!value && !walletOpen) generation++
    }
    fun onLifecycleEvent(event: Lifecycle.Event) {
        when (event) {
            Lifecycle.Event.ON_RESUME -> setForeground(true)
            Lifecycle.Event.ON_PAUSE, Lifecycle.Event.ON_STOP -> setForeground(false)
            else -> Unit
        }
    }
    fun close() { generation++; foreground.value = false }
    fun begin(): Long { checkCurrent(generation); return generation }
    fun checkCurrent(version: Long) {
        if (version != generation || (!foreground.value && !walletOpen)) throw CancellationException("Seeker screen is no longer active")
    }
    suspend fun <T> withWallet(version: Long, block: suspend () -> T): T {
        checkCurrent(version); walletOpen = true
        try {
            val result = block()
            foreground.first { it }
            checkCurrent(version)
            return result
        } finally { walletOpen = false }
    }
}
