package gg.pixelkingdomwars.nativeclient.seeker

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.starter.starterPrimitives
import kotlinx.coroutines.sync.Mutex
import java.util.Collections
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val shardsJournalJson = Json { encodeDefaults = true }
/** Exact original source and destination consent; cursor is never sent to POST.
 * Saved policy is historical grammar, never current admission authority. */
@Serializable data class SeekerShardsClaimCommand(val request: SeekerShardsClaimRequest, val termHash: String,
    val browseCursor: String?, val policy: SeekerShardsClaimsPolicy) {
    val key get() = request.idempotencyKey
    val receiptPath get() = "/seeker/shards/claims/by-key/$key"
    fun validate() { request.validate(policy); require(termHash.matches(Regex("[0-9a-f]{64}"))); browseCursor?.let(::uuid) }
    fun admit(identity: StarterIdentity, view: SeekerShardsEntitlementView, currentPolicy: SeekerShardsClaimsPolicy) {
        validate(); identity.validate(); require(policy == currentPolicy)
        view.match(identity.wallet, browseCursor, currentPolicy); require(view.claimsEnabled && view.status == "available")
        require(view.rows.any { it.termId == request.termId && it.termHash == termHash && it.spotId == request.spotId && it.dueQuantity != "0" })
    }
    fun match(receipt: SeekerShardsClaimReceipt, identity: StarterIdentity) {
        validate(); identity.validate(); receipt.match(identity.wallet, request, policy); require(receipt.termHash == termHash)
    }
}
@Serializable data class SeekerShardsClaimOperation(val command: SeekerShardsClaimCommand, val attemptRevision: Long?, val receipt: SeekerShardsClaimReceipt?)
@Serializable data class SeekerShardsClaimArchive(val operation: SeekerShardsClaimOperation, val reason: String)
@Serializable data class SeekerShardsClaimJournal(val version: Int, val identity: StarterIdentity, val revision: Long,
    val operation: SeekerShardsClaimOperation?, val archives: List<SeekerShardsClaimArchive>)

/** Encrypted actor journal. An ambiguous attempted command never becomes a fresh command. */
class SeekerShardsClaimStore(private val secret: SecretStore, identity: StarterIdentity, policy: SeekerShardsClaimsPolicy) {
    val identity = identity.copy().also { it.validate() }
    val policy = policy.copy().also { it.validate() }
    internal val requests = Mutex()
    private fun validate(j: SeekerShardsClaimJournal) {
        identity.validate(); require(j.version == 1 && j.identity == identity && j.revision >= 0)
        fun op(o: SeekerShardsClaimOperation) { o.command.validate(); o.attemptRevision?.let { require(it > 0 && it <= j.revision) }; o.receipt?.let { o.command.match(it, identity) } }
        j.operation?.let(::op); j.archives.forEach { a -> op(a.operation); when (a.reason) {
            "accepted" -> require(a.operation.receipt != null)
            "unattempted" -> require(a.operation.attemptRevision == null)
            // Dead-end audit 2026-10-06: an attempted request a fresh by-key read did not know; a late receipt may still merge.
            "server-unknown" -> require(a.operation.attemptRevision != null)
            else -> error("Unknown archive reason")
        } }
        val keys = j.archives.map { it.operation.command.key } + listOfNotNull(j.operation?.command?.key); require(keys.distinct().size == keys.size)
    }
    @Synchronized fun read(): SeekerShardsClaimJournal = (secret.read()?.let {
        val raw = shardsJournalJson.parseToJsonElement(it); starterPrimitives(raw, SeekerShardsClaimJournal.serializer().descriptor)
        shardsJournalJson.decodeFromJsonElement<SeekerShardsClaimJournal>(raw)
    } ?: SeekerShardsClaimJournal(1, identity, 0, null, emptyList())).also(::validate).let { it.copy(archives = Collections.unmodifiableList(it.archives.toList())) }
    private fun save(expected: SeekerShardsClaimJournal, next: SeekerShardsClaimJournal): SeekerShardsClaimJournal {
        check(read() == expected && expected.revision < Long.MAX_VALUE); val saved = next.copy(revision = expected.revision + 1); validate(saved)
        secret.write(shardsJournalJson.encodeToString(SeekerShardsClaimJournal.serializer(), saved)); return saved.copy(archives = Collections.unmodifiableList(saved.archives.toList()))
    }
    @Synchronized internal fun begin(expected: SeekerShardsClaimJournal, command: SeekerShardsClaimCommand): SeekerShardsClaimJournal {
        check(expected.operation == null); command.validate(); return save(expected, expected.copy(operation = SeekerShardsClaimOperation(command, null, null)))
    }
    @Synchronized internal fun attempt(expected: SeekerShardsClaimJournal): SeekerShardsClaimJournal {
        val op = requireNotNull(expected.operation); check(op.receipt == null && op.attemptRevision == null)
        return save(expected, expected.copy(operation = op.copy(attemptRevision = expected.revision + 1)))
    }
    @Synchronized internal fun accept(command: SeekerShardsClaimCommand, receipt: SeekerShardsClaimReceipt): SeekerShardsClaimJournal {
        command.match(receipt, identity); val saved = read()
        fun merge(op: SeekerShardsClaimOperation): SeekerShardsClaimOperation {
            check(op.command == command); op.receipt?.let { check(it == receipt) }; return op.copy(receipt = receipt)
        }
        val next = if (saved.operation?.command?.key == command.key) saved.copy(operation = merge(saved.operation)) else {
            check(saved.archives.any { it.operation.command.key == command.key })
            saved.copy(archives = saved.archives.map { if (it.operation.command.key == command.key) it.copy(operation = merge(it.operation)) else it })
        }
        return if (next == saved) saved else save(saved, next)
    }
    @Synchronized internal fun archive(expected: SeekerShardsClaimJournal, reason: String): SeekerShardsClaimJournal {
        val op = requireNotNull(expected.operation)
        check(reason == "accepted" && op.receipt != null || reason == "unattempted" && op.attemptRevision == null && op.receipt == null ||
            reason == "server-unknown" && op.attemptRevision != null && op.receipt == null)
        return save(expected, expected.copy(operation = null, archives = expected.archives + SeekerShardsClaimArchive(op, reason)))
    }
}
