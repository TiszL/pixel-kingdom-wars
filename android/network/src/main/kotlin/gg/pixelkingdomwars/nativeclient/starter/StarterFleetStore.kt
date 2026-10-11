package gg.pixelkingdomwars.nativeclient.starter

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class StarterFleetRefusal(val status: Int, val code: String)
fun starterFleetRefusalDefinitive(status: Int, code: String?): Boolean = code != null && mapOf(
    "BASE_NOT_OWNED" to 404, "BASE_ID_REQUIRED" to 409, "DEED_OWNERSHIP_CHANGED" to 409, "BASE_BEING_RAIDED" to 423,
    "DEED_AUTHORITY_UNAVAILABLE" to 503, "PHASE_E_DISABLED" to 503, "STARTER_BERTH_UNAVAILABLE" to 409, "STARTER_FAMILY_OCCUPIED" to 409, "STARTER_BERTH_OCCUPIED" to 409,
)[code] == status

@Serializable data class StarterFleetOperation(val command: StarterFleetCommand, val attemptRevision: Long?,
    val proof: StarterFleetProof?, val refusal: StarterFleetRefusal?)
@Serializable data class StarterFleetArchive(val operation: StarterFleetOperation, val reason: String, val evidence: StarterFleetProof?)
@Serializable data class StarterFleetJournal(val version: Int, val identity: StarterIdentity, val revision: Long,
    val operation: StarterFleetOperation?, val archives: List<StarterFleetArchive>)

/** One process-shared store per immutable origin/cluster/wallet. SecretStore must synchronously persist encrypted
 * bytes. Storage or schema failure preserves those bytes and refuses new commands, never resets to empty. */
class StarterFleetStore(private val secret: SecretStore, val identity: StarterIdentity) {
    internal val requests = Mutex()
    private fun validate(journal: StarterFleetJournal) {
        identity.validate(); require(journal.version == 1 && journal.identity == identity && journal.revision >= 0)
        fun operation(value: StarterFleetOperation) {
            value.command.validate(); value.attemptRevision?.let { require(it > 0 && it <= journal.revision) }
            value.proof?.let { it.validate(identity, value.command); require(it.status == "accepted") }
            value.refusal?.let { require(value.attemptRevision != null && starterFleetRefusalDefinitive(it.status, it.code)) }
        }
        journal.operation?.let(::operation)
        journal.archives.forEach { archive ->
            operation(archive.operation)
            when (archive.reason) {
                "accepted" -> require(archive.operation.proof != null && archive.evidence == null)
                "refused", "unattempted", "unknown" -> {
                    when (archive.reason) {
                        "refused" -> require(archive.operation.refusal != null)
                        "unattempted" -> require(archive.operation.attemptRevision == null && archive.operation.refusal == null)
                        // Owner 2026-10-06 (dead-end audit): an attempted, unrefused request closed after a fresh `unknown`.
                        else -> require(archive.operation.attemptRevision != null && archive.operation.refusal == null)
                    }
                    requireNotNull(archive.evidence).validate(identity, archive.operation.command); require(archive.evidence.status == "unknown")
                }
                else -> error("Unsupported starter installation archive")
            }
        }
        val keys = journal.archives.map { it.operation.command.key } + listOfNotNull(journal.operation?.command?.key)
        require(keys.distinct().size == keys.size)
    }
    @Synchronized fun read(): StarterFleetJournal = (secret.read()?.let {
        val raw = starterJson.parseToJsonElement(it); starterPrimitives(raw, StarterFleetJournal.serializer().descriptor)
        starterJson.decodeFromJsonElement<StarterFleetJournal>(raw)
    } ?: StarterFleetJournal(1, identity, 0, null, emptyList())).also(::validate)
    private fun save(expected: StarterFleetJournal, next: StarterFleetJournal): StarterFleetJournal {
        check(read() == expected) { "The original starter installation record changed." }; check(expected.revision < Long.MAX_VALUE)
        val saved = next.copy(revision = expected.revision + 1); validate(saved)
        secret.write(starterJson.encodeToString(StarterFleetJournal.serializer(), saved)); return saved
    }
    @Synchronized internal fun begin(expected: StarterFleetJournal, command: StarterFleetCommand): StarterFleetJournal {
        check(expected.operation == null); command.validate()
        return save(expected, expected.copy(operation = StarterFleetOperation(command, null, null, null)))
    }
    @Synchronized internal fun attempt(expected: StarterFleetJournal): StarterFleetJournal {
        val original = requireNotNull(expected.operation); check(original.proof == null && original.refusal == null); check(expected.revision < Long.MAX_VALUE)
        return save(expected, expected.copy(operation = original.copy(attemptRevision = expected.revision + 1)))
    }
    /** A late original response can add proof after cancellation or another explicit attempt, but never replace
     * its frozen receipt or regress return proof. All archives can retain later acceptance without changing their original archive evidence. */
    @Synchronized internal fun accept(command: StarterFleetCommand, proof: StarterFleetProof): StarterFleetJournal {
        proof.validate(identity, command); require(proof.status == "accepted"); val saved = read()
        fun merge(original: StarterFleetOperation): StarterFleetOperation {
            check(original.command == command)
            original.proof?.let {
                check(it.receipt == proof.receipt) { "The accepted original starter receipt changed." }
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
    @Synchronized internal fun refuse(attempt: StarterFleetJournal, refusal: StarterFleetRefusal): StarterFleetJournal {
        val original = requireNotNull(attempt.operation); check(original.attemptRevision == attempt.revision)
        require(starterFleetRefusalDefinitive(refusal.status, refusal.code)); val current = read()
        if (current != attempt || current.operation?.proof != null) return current
        return save(current, current.copy(operation = original.copy(refusal = refusal)))
    }
    @Synchronized internal fun archive(expected: StarterFleetJournal, reason: String, evidence: StarterFleetProof?): StarterFleetJournal {
        val original = requireNotNull(expected.operation)
        // Later recovery can add acceptance to any archive, but its original reason must be truthful when created.
        check(reason == "accepted" || original.proof == null)
        return save(expected, expected.copy(operation = null, archives = expected.archives + StarterFleetArchive(original, reason, evidence)))
    }
}
