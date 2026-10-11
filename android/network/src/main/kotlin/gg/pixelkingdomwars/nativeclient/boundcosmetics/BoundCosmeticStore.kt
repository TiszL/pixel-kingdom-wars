@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
package gg.pixelkingdomwars.nativeclient.boundcosmetics

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.Serializable

/** [closedUnknown]: owner rule 2026-10-06 — an attempted original archived after the same action's by-key GET answered
 * "unknown" for its key. Never written while false, so existing Awning and Wake bytes decode and re-encode unchanged. */
@Serializable data class BoundCosmeticOperation(val command: BoundCosmeticCommand, val attempted: Boolean, val proof: BoundCosmeticProof?,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val closedUnknown: Boolean = false)
@Serializable data class BoundCosmeticJournal(val version: Int, val identity: BoundCosmeticIdentity, val revision: Long,
    val operation: BoundCosmeticOperation?, val archives: List<BoundCosmeticOperation>)

/** One process-shared store per origin/cluster/wallet, backed by the existing encrypted SecretStore.
 * Parse/storage failure preserves bytes and fails closed. A lost response never authorizes a replacement key. */
class BoundCosmeticStore(private val secret: SecretStore, val identity: BoundCosmeticIdentity,
    val mode: BoundCosmeticMode = BoundCosmeticMode.AWNING, val requests: Mutex = Mutex()) {
    private fun validate(journal: BoundCosmeticJournal) {
        identity.validate(); require(journal.version == 1 && journal.identity == identity && journal.revision >= 0)
        val operations = journal.archives + listOfNotNull(journal.operation)
        require(operations.map { it.command.key }.distinct().size == operations.size)
        operations.forEach { op -> op.command.validate(mode); op.proof?.let { proof ->
            proof.match(identity, op.command, mode); require(op.attempted && proof.status == "accepted") }
            if (op.closedUnknown) require(op.attempted) }
        require(journal.operation?.closedUnknown != true)
        // A closed unknown may later gain its late proof (checkArchived); it never needs one to stay readable.
        require(journal.archives.none { it.attempted && it.proof == null && !it.closedUnknown })
    }
    @Synchronized fun read(): BoundCosmeticJournal = (secret.read()?.let {
        cosmeticDecode(cosmeticJson.parseToJsonElement(it), BoundCosmeticJournal.serializer())
    } ?: BoundCosmeticJournal(1, identity, 0, null, emptyList())).also(::validate)
    private fun save(expected: BoundCosmeticJournal, next: BoundCosmeticJournal): BoundCosmeticJournal {
        check(read() == expected) { "The original Awning record changed. Read it again." }
        check(expected.revision < Long.MAX_VALUE); val saved = next.copy(revision = expected.revision + 1); validate(saved)
        val bytes = cosmeticJson.encodeToString(BoundCosmeticJournal.serializer(), saved)
        secret.write(bytes)
        // Return an owned parse, never a caller's mutable recipe-list reference.
        return cosmeticDecode(cosmeticJson.parseToJsonElement(bytes), BoundCosmeticJournal.serializer())
    }
    @Synchronized fun begin(expected: BoundCosmeticJournal, command: BoundCosmeticCommand): BoundCosmeticJournal {
        check(expected.operation == null); command.validate(mode)
        return save(expected, expected.copy(operation = BoundCosmeticOperation(command, false, null)))
    }
    @Synchronized fun attempt(expected: BoundCosmeticJournal): BoundCosmeticJournal {
        val original = requireNotNull(expected.operation); check(original.proof == null)
        return save(expected, expected.copy(operation = original.copy(attempted = true)))
    }
    /** Late complete original evidence can be retained after an obsolete view without publishing current facts. */
    @Synchronized fun accept(command: BoundCosmeticCommand, proof: BoundCosmeticProof): BoundCosmeticJournal {
        proof.match(identity, command, mode); require(proof.status == "accepted"); val saved = read()
        fun merge(original: BoundCosmeticOperation): BoundCosmeticOperation {
            check(original.command == command)
            original.proof?.let { previous ->
                check(previous.receipt == proof.receipt) { "Original acceptance changed" }
                previous.completion?.let { check(it == proof.completion) { "Original completion changed or disappeared" } }
            }
            return original.copy(attempted = true, proof = proof)
        }
        val current = saved.operation
        val next = if (current?.command?.key == command.key) saved.copy(operation = merge(current)) else {
            val index = saved.archives.indexOfFirst { it.command.key == command.key }; check(index >= 0)
            saved.copy(archives = saved.archives.mapIndexed { at, row -> if (at == index) merge(row) else row })
        }
        return if (saved == next) saved else save(saved, next)
    }
    /** Caller observes the original before invoking archival. An attempted original without proof leaves recovery only
     * with [unknown]: the by-key reply the caller fetched in this same action, answering "unknown" for exactly its key. */
    @Synchronized fun archive(expected: BoundCosmeticJournal, unknown: BoundCosmeticProof? = null): BoundCosmeticJournal {
        val original = requireNotNull(expected.operation); val closing = original.attempted && original.proof == null
        if (closing) requireNotNull(unknown) { "Check the original receipt before closing it." }.let {
            it.match(identity, original.command, mode); check(it.status == "unknown") { "The original was accepted. Keep its receipt." } }
        return save(expected, expected.copy(operation = null, archives = expected.archives + original.copy(closedUnknown = closing)))
    }
}
