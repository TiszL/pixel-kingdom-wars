package gg.pixelkingdomwars.nativeclient.ui.army

import gg.pixelkingdomwars.nativeclient.ops.ReceiptObserver
import kotlinx.coroutines.CancellationException

/** Land entry must keep recovery reachable when the journal cannot be read, without repairing it. */
internal suspend fun refreshResearchRecoveryEntry(observer: ReceiptObserver, wallet: String): String? = try {
    observer.refresh(wallet)
    null
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    "Saved payments could not be read. Open recovery to try again, and keep this app's data."
}
