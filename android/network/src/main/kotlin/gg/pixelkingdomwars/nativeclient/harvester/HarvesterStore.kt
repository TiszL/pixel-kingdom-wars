package gg.pixelkingdomwars.nativeclient.harvester

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class HarvesterRefusal(val status: Int, val code: String)
fun harvesterRefusalDefinitive(status: Int, code: String?): Boolean = code != null && mapOf(
    "BASE_NOT_OWNED" to 404, "BASE_ID_REQUIRED" to 409, "DEED_OWNERSHIP_CHANGED" to 409, "BASE_BEING_RAIDED" to 423,
    "DEED_AUTHORITY_UNAVAILABLE" to 503, "HARVESTERS_DISABLED" to 503, "EXPEDITION_TERM_UNAVAILABLE" to 503,
    "EXPEDITION_HOME_UNAVAILABLE" to 409, "HARVESTER_SOURCE_CHANGED" to 409, "HARVESTER_SOURCE_PENDING" to 409,
    "HARVESTER_POLICY_CHANGED" to 409, "HARVESTER_FACILITY_UNAVAILABLE" to 409, "HARVESTER_SETTLEMENT_PENDING" to 409,
)[code] == status

@Serializable data class HarvesterOperation(val command: HarvesterCommand, val attemptRevision: Long?,
    val proof: HarvesterProof?, val refusal: HarvesterRefusal?)
@Serializable data class HarvesterArchive(val operation: HarvesterOperation, val reason: String, val evidence: HarvesterProof?)
@Serializable data class HarvesterJournal(val version: Int, val identity: HarvesterIdentity, val revision: Long,
    val operation: HarvesterOperation?, val archives: List<HarvesterArchive>)

/** One process-shared store per immutable origin/cluster/wallet. SecretStore must synchronously persist encrypted
 * bytes. Storage or schema failure preserves those bytes and refuses new commands, never resets to empty. */
class HarvesterStore(private val secret: SecretStore, val identity: HarvesterIdentity) {
    internal val requests = Mutex()
    private fun validate(journal: HarvesterJournal) {
        identity.validate(); require(journal.version == 1 && journal.identity == identity && journal.revision >= 0)
        fun operation(value: HarvesterOperation) {
            value.command.validate(); value.attemptRevision?.let { require(it > 0 && it <= journal.revision) }
            value.proof?.let { it.validate(identity, value.command); require(it.status == "accepted") }
            value.refusal?.let { require(value.attemptRevision != null && harvesterRefusalDefinitive(it.status, it.code)) }
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
                else -> error("Unsupported Harvester source archive")
            }
        }
        val keys = journal.archives.map { it.operation.command.key } + listOfNotNull(journal.operation?.command?.key)
        require(keys.distinct().size == keys.size)
    }
    @Synchronized fun read(): HarvesterJournal = (secret.read()?.let {
        val raw = harvesterJson.parseToJsonElement(it); strictPrimitives(raw, HarvesterJournal.serializer().descriptor)
        harvesterJson.decodeFromJsonElement<HarvesterJournal>(raw)
    } ?: HarvesterJournal(1, identity, 0, null, emptyList())).also(::validate)
    private fun save(expected: HarvesterJournal, next: HarvesterJournal): HarvesterJournal {
        check(read() == expected) { "The original Harvester source record changed." }; check(expected.revision < Long.MAX_VALUE)
        val saved = next.copy(revision = expected.revision + 1); validate(saved)
        secret.write(harvesterJson.encodeToString(HarvesterJournal.serializer(), saved)); return saved
    }
    @Synchronized internal fun begin(expected: HarvesterJournal, command: HarvesterCommand): HarvesterJournal {
        check(expected.operation == null); command.validate()
        return save(expected, expected.copy(operation = HarvesterOperation(command, null, null, null)))
    }
    @Synchronized internal fun attempt(expected: HarvesterJournal): HarvesterJournal {
        val original = requireNotNull(expected.operation); check(original.proof == null && original.refusal == null); check(expected.revision < Long.MAX_VALUE)
        return save(expected, expected.copy(operation = original.copy(attemptRevision = expected.revision + 1)))
    }
    /** A late original response can add proof after cancellation or another explicit attempt, but never replace
     * its frozen receipt or regress settlement proof. All archives can retain later acceptance without changing their original archive evidence. */
    @Synchronized internal fun accept(command: HarvesterCommand, proof: HarvesterProof): HarvesterJournal {
        proof.validate(identity, command); require(proof.status == "accepted"); val saved = read()
        fun merge(original: HarvesterOperation): HarvesterOperation {
            check(original.command == command)
            original.proof?.let {
                check(it.originalReceipt == proof.originalReceipt) { "The accepted original Harvester receipt changed." }
                check(requireNotNull(proof.settlement).preserves(requireNotNull(it.settlement))) { "Original Harvester settlement changed or disappeared." }
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
    @Synchronized internal fun refuse(attempt: HarvesterJournal, refusal: HarvesterRefusal): HarvesterJournal {
        val original = requireNotNull(attempt.operation); check(original.attemptRevision == attempt.revision)
        require(harvesterRefusalDefinitive(refusal.status, refusal.code)); val current = read()
        if (current != attempt || current.operation?.proof != null) return current
        return save(current, current.copy(operation = original.copy(refusal = refusal)))
    }
    @Synchronized internal fun archive(expected: HarvesterJournal, reason: String, evidence: HarvesterProof?): HarvesterJournal {
        val original = requireNotNull(expected.operation)
        // Later recovery can add acceptance to any archive, but its original reason must be truthful when created.
        check(reason == "accepted" || original.proof == null)
        return save(expected, expected.copy(operation = null, archives = expected.archives + HarvesterArchive(original, reason, evidence)))
    }
}
