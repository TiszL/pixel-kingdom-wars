package gg.pixelkingdomwars.nativeclient.data

import kotlinx.coroutines.Deferred

/** One existing per-open owner coordinates source revocation with its admission
 * listeners and Main-thread host cleanup. Registration precedes open-ticket
 * settlement. Callbacks run outside coordinator locks; cleanup completion is
 * unparented from the cancelled account/collector and never awaited by a source.
 * Interface pinned by MS-C note 505a2b5e377bcadb314837c2097ee13ccc36107eefa68d5f66996e1ce8274a6a. */
interface ServiceContentRetirement {
    /** Published before any revoker or invalidation callback runs. */
    val requested: Boolean
    /** Revoke immediately if already requested; retain physical close until the
     * open ticket and invalidation drain permit it. Each callback runs once. */
    fun registerSource(revoke: () -> Unit, close: () -> Unit)
    /** Host/permission cleanup runs before registered physical source closes. */
    fun beforeSourceClose(close: () -> Unit)
    /** Request without waiting: a partial open must settle its own ticket first. */
    fun requestRetirement(): Deferred<Unit>
}
