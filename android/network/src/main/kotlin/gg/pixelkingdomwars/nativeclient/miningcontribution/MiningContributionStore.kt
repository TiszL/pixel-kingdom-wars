package gg.pixelkingdomwars.nativeclient.miningcontribution

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class MiningContributionRefusal(val status: Int, val code: String)
fun miningContributionRefusalDefinitive(status: Int, code: String?): Boolean = code != null && mapOf(
    "DEVELOPMENT_REQUIRED" to 422, "MINING_DAY_CHANGED" to 409, "MINING_POLICY_CHANGED" to 409,
    "MINING_FREE_CAP_EXCEEDED" to 422, "INSUFFICIENT_MINING_RESOURCES" to 422,
)[code] == status

@Serializable data class MiningContributionOperation(val command: MiningContributionCommand, val attemptRevision: Long?,
    val proof: MiningContributionProof?, val refusal: MiningContributionRefusal?)
@Serializable data class MiningContributionArchive(val operation: MiningContributionOperation, val reason: String, val evidence: MiningContributionProof?)
@Serializable data class MiningContributionJournal(val version: Int, val identity: MiningContributionIdentity, val revision: Long,
    val operation: MiningContributionOperation?, val archives: List<MiningContributionArchive>)

/** One process-shared store per immutable origin/cluster/wallet. SecretStore must synchronously persist encrypted
 * bytes. Storage or schema failure preserves those bytes and refuses new commands, never resets to empty. */
class MiningContributionStore(private val secret: SecretStore, val identity: MiningContributionIdentity) {
    internal val requests = Mutex()
    private fun validate(journal: MiningContributionJournal) {
        identity.validate(); require(journal.version == 1 && journal.identity == identity && journal.revision >= 0)
        fun operation(value: MiningContributionOperation) {
            value.command.validate(); value.attemptRevision?.let { require(it > 0 && it <= journal.revision) }
            value.proof?.let { it.validate(identity, value.command); require(it.status == "accepted") }
            value.refusal?.let { require(value.attemptRevision != null && miningContributionRefusalDefinitive(it.status, it.code)) }
        }
        journal.operation?.let(::operation)
        journal.archives.forEach { archive ->
            operation(archive.operation)
            when (archive.reason) {
                "accepted" -> require(archive.operation.proof != null && archive.evidence == null)
                "refused", "unattempted" -> {
                    if (archive.reason == "refused") require(archive.operation.refusal != null) else require(archive.operation.attemptRevision == null && archive.operation.refusal == null)
                    requireNotNull(archive.evidence).validate(identity, archive.operation.command); require(archive.evidence.status == "unknown")
                }
                // Dead-end audit 2026-10-06: an attempted request a fresh by-key read did not know; a late proof may still merge.
                "server-unknown" -> {
                    require(archive.operation.attemptRevision != null && archive.operation.refusal == null)
                    requireNotNull(archive.evidence).validate(identity, archive.operation.command); require(archive.evidence.status == "unknown")
                }
                else -> error("Unsupported mining contribution archive")
            }
        }
        val keys = journal.archives.map { it.operation.command.key } + listOfNotNull(journal.operation?.command?.key)
        require(keys.distinct().size == keys.size)
    }
    @Synchronized fun read(): MiningContributionJournal = (secret.read()?.let {
        val raw = contributionJson.parseToJsonElement(it); strictPrimitives(raw, MiningContributionJournal.serializer().descriptor)
        contributionJson.decodeFromJsonElement<MiningContributionJournal>(raw)
    } ?: MiningContributionJournal(1, identity, 0, null, emptyList())).also(::validate)
    private fun save(expected: MiningContributionJournal, next: MiningContributionJournal): MiningContributionJournal {
        check(read() == expected) { "The original mining contribution record changed." }; check(expected.revision < Long.MAX_VALUE)
        val saved = next.copy(revision = expected.revision + 1); validate(saved)
        secret.write(contributionJson.encodeToString(MiningContributionJournal.serializer(), saved)); return saved
    }
    @Synchronized internal fun begin(expected: MiningContributionJournal, command: MiningContributionCommand): MiningContributionJournal {
        check(expected.operation == null); command.validate()
        return save(expected, expected.copy(operation = MiningContributionOperation(command, null, null, null)))
    }
    @Synchronized internal fun attempt(expected: MiningContributionJournal): MiningContributionJournal {
        val original = requireNotNull(expected.operation); check(original.proof == null && original.refusal == null); check(expected.revision < Long.MAX_VALUE)
        return save(expected, expected.copy(operation = original.copy(attemptRevision = expected.revision + 1)))
    }
    /** A late original response can add proof after cancellation or another explicit attempt, but never replace
     * its frozen start or regress settlement. All archives can retain later acceptance without changing their original archive evidence. */
    @Synchronized internal fun accept(command: MiningContributionCommand, proof: MiningContributionProof): MiningContributionJournal {
        proof.validate(identity, command); require(proof.status == "accepted"); val saved = read()
        fun merge(original: MiningContributionOperation): MiningContributionOperation {
            check(original.command == command)
            original.proof?.let {
                check(it.receipt == proof.receipt) { "The accepted original contribution receipt changed." }
                if (it.settlement != null) check(it.settlement == proof.settlement) { "Original contribution settlement changed or disappeared." }
            }
            return original.copy(proof = proof)
        }
        val current = saved.operation
        val next = if (current?.command?.key == command.key) saved.copy(operation = merge(current)) else {
            val index = saved.archives.indexOfFirst { it.operation.command.key == command.key }; check(index >= 0)
            val archive = saved.archives[index]
            saved.copy(archives = saved.archives.mapIndexed { at, row -> if (at == index) archive.copy(operation = merge(archive.operation)) else row })
        }
        return if (next == saved) saved else save(saved, next)
    }
    /** Only the first POST's callback may supply a refusal. Its persisted attempt revision must still be current;
     * an earlier response cannot clear or mark a newer attempt or an already retained accepted proof. */
    @Synchronized internal fun refuse(attempt: MiningContributionJournal, refusal: MiningContributionRefusal): MiningContributionJournal {
        val original = requireNotNull(attempt.operation); check(original.attemptRevision == attempt.revision)
        require(miningContributionRefusalDefinitive(refusal.status, refusal.code)); val current = read()
        if (current != attempt || current.operation?.proof != null) return current
        return save(current, current.copy(operation = original.copy(refusal = refusal)))
    }
    @Synchronized internal fun archive(expected: MiningContributionJournal, reason: String, evidence: MiningContributionProof?): MiningContributionJournal {
        val original = requireNotNull(expected.operation)
        // Later recovery can add acceptance to any archive, but its original reason must be truthful when created.
        check(reason == "accepted" || original.proof == null)
        return save(expected, expected.copy(operation = null, archives = expected.archives + MiningContributionArchive(original, reason, evidence)))
    }
}
