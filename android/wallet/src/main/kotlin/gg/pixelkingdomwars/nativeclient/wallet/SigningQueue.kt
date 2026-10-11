package gg.pixelkingdomwars.nativeclient.wallet

import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Own the reviewed payload before a queued request can suspend. */
internal class SigningQueue(private val context: CoroutineContext = EmptyCoroutineContext) {
    private val mutex = Mutex()

    suspend fun <T> run(bytes: ByteArray, onCancelled: () -> Unit = {}, operation: suspend (ByteArray) -> T): T {
        val input=bytes.copyOf()
        return mutex.withLock {
            withContext(context) {
                coroutineScope {
                    var finished=false
                    // Privy 0.14 MFA uses suspendCoroutine. A sibling cancellation handler
                    // can resume that SDK wait before the signing coroutine reaches catch.
                    val cancellation=launch(start=CoroutineStart.UNDISPATCHED) {
                        try { awaitCancellation() }
                        finally { if(!finished) onCancelled() }
                    }
                    try { operation(input) }
                    finally { finished=true; cancellation.cancel() }
                }
            }
        }
    }
}
