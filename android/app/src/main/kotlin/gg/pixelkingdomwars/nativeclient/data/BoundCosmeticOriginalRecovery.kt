package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import kotlinx.serialization.json.JsonObject

/** Both explicit Workshop siblings share the same original custody boundary. Evidence is
 * retained synchronously before current-view guards, including late/cancelled responses. */
internal class BoundCosmeticOriginalRecovery(private val api: ApiClient, private val store: BoundCosmeticStore) {
    fun retain(command: BoundCosmeticCommand, raw: JsonObject): BoundCosmeticProof =
        BoundCosmeticProof.from(raw, store.identity, command, store.mode).also {
            if (it.status == "accepted") store.accept(command, it)
        }

    suspend fun observe(command: BoundCosmeticCommand, guard: () -> Unit): BoundCosmeticJournal = observed(command, guard).first

    /** The same by-key read, also returning this action's own verified reply, so an archive can bind its
     * close to a fresh "unknown" for exactly this key (owner rule 2026-10-06). */
    suspend fun observed(command: BoundCosmeticCommand, guard: () -> Unit): Pair<BoundCosmeticJournal, BoundCosmeticProof> {
        guard()
        val raw = api.getBoundCosmetic(command.receiptPath, emptyMap(), guard) { retain(command, it) }
        val proof = retain(command, raw)
        guard()
        val saved = store.read()
        check(proof.status == "accepted" || (saved.archives + listOfNotNull(saved.operation)).none {
            it.command.key == command.key && it.proof != null
        }) { "Previously accepted receipt is unavailable. Saved acceptance remains unchanged." }
        return saved to proof
    }
}
