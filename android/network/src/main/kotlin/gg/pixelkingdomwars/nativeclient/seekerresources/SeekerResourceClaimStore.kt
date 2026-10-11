package gg.pixelkingdomwars.nativeclient.seekerresources

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.starter.starterPrimitives
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class SeekerResourceClaimOperation(val command: SeekerResourceClaimCommand, val attemptRevision: Long?, val receipt: SeekerResourceClaimReceipt?)
@Serializable data class SeekerResourceClaimArchive(val operation: SeekerResourceClaimOperation, val reason: String)
@Serializable data class SeekerResourceClaimJournal(val version: Int, val identity: StarterIdentity, val revision: Long,
    val operation: SeekerResourceClaimOperation?, val archives: List<SeekerResourceClaimArchive>)

/** Encrypted actor journal. An ambiguous attempted command never becomes a fresh command. */
class SeekerResourceClaimStore(private val secret: SecretStore, val identity: StarterIdentity) {
    internal val requests = Mutex()
    private fun validate(j: SeekerResourceClaimJournal) {
        identity.validate(); require(j.version == 1 && j.identity == identity && j.revision >= 0)
        fun op(o: SeekerResourceClaimOperation) { o.command.validate(); o.attemptRevision?.let { require(it > 0 && it <= j.revision) }; o.receipt?.validate(identity, o.command) }
        j.operation?.let(::op); j.archives.forEach { a -> op(a.operation); when (a.reason) {
            "accepted" -> require(a.operation.receipt != null)
            "unattempted" -> require(a.operation.attemptRevision == null)
            // Dead-end audit 2026-10-06: an attempted request a fresh by-key read did not know; a late receipt may still merge.
            "server-unknown" -> require(a.operation.attemptRevision != null)
            else -> error("Unknown archive reason")
        } }
        val keys = j.archives.map { it.operation.command.key } + listOfNotNull(j.operation?.command?.key); require(keys.distinct().size == keys.size)
    }
    @Synchronized fun read(): SeekerResourceClaimJournal = (secret.read()?.let {
        val raw = seekerResourceJson.parseToJsonElement(it); starterPrimitives(raw, SeekerResourceClaimJournal.serializer().descriptor)
        seekerResourceJson.decodeFromJsonElement<SeekerResourceClaimJournal>(raw)
    } ?: SeekerResourceClaimJournal(1, identity, 0, null, emptyList())).also(::validate)
    private fun save(expected: SeekerResourceClaimJournal, next: SeekerResourceClaimJournal): SeekerResourceClaimJournal {
        check(read() == expected && expected.revision < Long.MAX_VALUE); val saved = next.copy(revision = expected.revision + 1); validate(saved)
        secret.write(seekerResourceJson.encodeToString(SeekerResourceClaimJournal.serializer(), saved)); return saved
    }
    @Synchronized internal fun begin(expected: SeekerResourceClaimJournal, command: SeekerResourceClaimCommand): SeekerResourceClaimJournal {
        check(expected.operation == null); command.validate(); return save(expected, expected.copy(operation = SeekerResourceClaimOperation(command, null, null)))
    }
    @Synchronized internal fun attempt(expected: SeekerResourceClaimJournal): SeekerResourceClaimJournal {
        val op = requireNotNull(expected.operation); check(op.receipt == null && op.attemptRevision == null)
        return save(expected, expected.copy(operation = op.copy(attemptRevision = expected.revision + 1)))
    }
    @Synchronized internal fun accept(command: SeekerResourceClaimCommand, receipt: SeekerResourceClaimReceipt): SeekerResourceClaimJournal {
        receipt.validate(identity, command); val saved = read()
        fun merge(op: SeekerResourceClaimOperation): SeekerResourceClaimOperation {
            check(op.command == command); op.receipt?.let { check(it == receipt) }; return op.copy(receipt = receipt)
        }
        val next = if (saved.operation?.command?.key == command.key) saved.copy(operation = merge(saved.operation)) else {
            check(saved.archives.any { it.operation.command.key == command.key })
            saved.copy(archives = saved.archives.map { if (it.operation.command.key == command.key) it.copy(operation = merge(it.operation)) else it })
        }
        return if (next == saved) saved else save(saved, next)
    }
    @Synchronized internal fun archive(expected: SeekerResourceClaimJournal, reason: String): SeekerResourceClaimJournal {
        val op = requireNotNull(expected.operation)
        check(reason == "accepted" && op.receipt != null || reason == "unattempted" && op.attemptRevision == null && op.receipt == null ||
            reason == "server-unknown" && op.attemptRevision != null && op.receipt == null)
        return save(expected, expected.copy(operation = null, archives = expected.archives + SeekerResourceClaimArchive(op, reason)))
    }
}
