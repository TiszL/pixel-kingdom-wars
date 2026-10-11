package gg.pixelkingdomwars.nativeclient.workshop

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class WorkshopRefusal(val status: Int, val code: String)
fun workshopRefusalDefinitive(kind: String, status: Int, code: String?): Boolean {
    val common = mapOf("BASE_NOT_OWNED" to 404, "BASE_ID_REQUIRED" to 409, "DEED_OWNERSHIP_CHANGED" to 409, "BASE_BEING_RAIDED" to 423, "DEED_AUTHORITY_UNAVAILABLE" to 503)
    val specific = when (kind) {
        "start" -> mapOf("PHASE_E_DISABLED" to 503, "RECIPE_VERSION_STALE" to 409, "WORKSHOP_REQUIRED" to 409, "BATCH_EXCEEDED" to 422, "REFINE_CAP_EXCEEDED" to 422, "HOLDING_CAP_EXCEEDED" to 422, "INSUFFICIENT_SHARDS" to 422)
        "collect" -> mapOf("JOB_NOT_FOUND" to 404, "JOB_ALREADY_COLLECTED" to 409, "JOB_NOT_READY" to 409)
        else -> return false
    }
    return code != null && (specific[code] ?: common[code]) == status
}
@Serializable data class WorkshopOperation(val command: WorkshopCommand, val attempted: Boolean, val proof: WorkshopProof?, val refusal: WorkshopRefusal?)
@Serializable data class WorkshopArchive(val operation: WorkshopOperation, val reason: String, val evidence: WorkshopProof?)
@Serializable data class WorkshopJournal(val version: Int, val identity: WorkshopIdentity, val revision: Long, val operation: WorkshopOperation?, val archives: List<WorkshopArchive>)

/** One process-shared instance per immutable API origin/cluster/wallet. SecretStore must be encrypted
 * and synchronously durable. Unknown schema/storage failure is never treated as an empty journal. */
class WorkshopStore(private val secret: SecretStore, val identity: WorkshopIdentity) {
    internal val requests = Mutex()
    private fun validateOperation(o: WorkshopOperation) {
        o.command.validate(); o.proof?.let { it.validate(identity, o.command); require(it.status == "accepted") }
        o.refusal?.let { require(o.attempted && o.proof == null && workshopRefusalDefinitive(o.command.kind, it.status, it.code)) }
    }
    private fun validate(j: WorkshopJournal) {
        identity.validate(); require(j.version == 1 && j.identity == identity && j.revision >= 0)
        j.operation?.let(::validateOperation)
        j.archives.forEach { a ->
            validateOperation(a.operation)
            when (a.reason) {
                "accepted" -> require(a.operation.proof != null && a.evidence == null)
                "refused", "unattempted", "unknown" -> {
                    when (a.reason) {
                        "refused" -> require(a.operation.refusal != null)
                        "unattempted" -> require(!a.operation.attempted && a.operation.proof == null)
                        // Owner 2026-10-06 (dead-end audit): an attempted, unrefused request closed after a fresh `unknown`.
                        else -> require(a.operation.attempted && a.operation.refusal == null && a.operation.proof == null)
                    }
                    requireNotNull(a.evidence).validate(identity, a.operation.command); require(a.evidence.status == "unknown")
                }
                else -> error("Invalid Workshop archive")
            }
        }
        val keys = (j.archives.map { it.operation } + listOfNotNull(j.operation)).map { it.command.key }; require(keys.distinct().size == keys.size)
    }
    @Synchronized fun read(): WorkshopJournal = (secret.read()?.let { val raw = workshopJson.parseToJsonElement(it); strictPrimitives(raw, WorkshopJournal.serializer().descriptor); workshopJson.decodeFromJsonElement<WorkshopJournal>(raw) }
        ?: WorkshopJournal(1, identity, 0, null, emptyList())).also(::validate)
    private fun save(expected: WorkshopJournal, next: WorkshopJournal): WorkshopJournal {
        check(read() == expected) { "The original Workshop record changed." }; check(expected.revision < Long.MAX_VALUE)
        val result = next.copy(revision = expected.revision + 1); validate(result)
        secret.write(workshopJson.encodeToString(WorkshopJournal.serializer(), result)); return result
    }
    @Synchronized fun begin(expected: WorkshopJournal, command: WorkshopCommand, proof: WorkshopProof? = null): WorkshopJournal {
        check(expected.operation == null); return save(expected, expected.copy(operation = WorkshopOperation(command, false, proof, null)))
    }
    @Synchronized internal fun attempt(expected: WorkshopJournal): WorkshopJournal {
        val o = requireNotNull(expected.operation); check(o.proof == null && o.refusal == null)
        return save(expected, expected.copy(operation = o.copy(attempted = true)))
    }
    @Synchronized internal fun accept(expected: WorkshopJournal, proof: WorkshopProof): WorkshopJournal {
        val o = requireNotNull(expected.operation); proof.validate(identity, o.command); check(proof.status == "accepted" && o.refusal == null)
        if (o.proof != null) { check(o.proof.receipt == proof.receipt); check(read() == expected); return expected }
        return save(expected, expected.copy(operation = o.copy(proof = proof)))
    }
    /** Only the engine may supply evidence from its first POST catch (never receipt GET or retry). */
    @Synchronized internal fun refuse(expected: WorkshopJournal, refusal: WorkshopRefusal): WorkshopJournal {
        val o = requireNotNull(expected.operation); check(o.attempted && o.proof == null && o.refusal == null)
        return save(expected, expected.copy(operation = o.copy(refusal = refusal)))
    }
    @Synchronized internal fun archive(expected: WorkshopJournal, reason: String, proof: WorkshopProof?): WorkshopJournal {
        val o = requireNotNull(expected.operation)
        return save(expected, expected.copy(operation = null, archives = expected.archives + WorkshopArchive(o, reason, proof)))
    }
}
