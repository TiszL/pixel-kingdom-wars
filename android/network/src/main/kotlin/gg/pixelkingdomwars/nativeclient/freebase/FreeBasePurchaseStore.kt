package gg.pixelkingdomwars.nativeclient.freebase

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.starter.starterPrimitives
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class FreeBasePurchaseOperation(val command: FreeBasePurchaseCommand, val attemptRevision: Long?, val receipt: FreeBasePurchaseReceipt?)
@Serializable data class FreeBasePurchaseJournal(val version: Int, val identity: StarterIdentity, val revision: Long, val operation: FreeBasePurchaseOperation?)

/** One lifetime purchase per wallet. Source is immutable inside the original command, so changing selected
 * bases never hides recovery. No discard API exists for an accepted operation; an unaccepted one may only be
 * closed by [FreeBasePurchaseTransport.close] after a fresh by-key read answered no receipt (dead-end audit 2026-10-06). */
class FreeBasePurchaseStore(private val secret: SecretStore, val identity: StarterIdentity) {
    internal val requests = Mutex()
    private fun validate(journal: FreeBasePurchaseJournal) {
        identity.validate(); require(journal.version == 1 && journal.identity == identity && journal.revision >= 0)
        journal.operation?.let { op -> op.command.validate(); op.attemptRevision?.let { require(it > 0 && it <= journal.revision) }; op.receipt?.validate(identity, op.command) }
    }
    @Synchronized fun read(): FreeBasePurchaseJournal = (secret.read()?.let {
        val raw = freeBaseJson.parseToJsonElement(it); starterPrimitives(raw, FreeBasePurchaseJournal.serializer().descriptor)
        freeBaseJson.decodeFromJsonElement<FreeBasePurchaseJournal>(raw)
    } ?: FreeBasePurchaseJournal(1, identity, 0, null)).also(::validate)
    private fun save(expected: FreeBasePurchaseJournal, next: FreeBasePurchaseJournal): FreeBasePurchaseJournal {
        check(read() == expected && expected.revision < Long.MAX_VALUE)
        val saved = next.copy(revision = expected.revision + 1); validate(saved)
        secret.write(freeBaseJson.encodeToString(FreeBasePurchaseJournal.serializer(), saved)); return saved
    }
    @Synchronized internal fun begin(expected: FreeBasePurchaseJournal, command: FreeBasePurchaseCommand): FreeBasePurchaseJournal {
        check(expected.operation == null); command.validate()
        return save(expected, expected.copy(operation = FreeBasePurchaseOperation(command, null, null)))
    }
    @Synchronized internal fun attempt(expected: FreeBasePurchaseJournal): FreeBasePurchaseJournal {
        val op = requireNotNull(expected.operation); check(op.receipt == null && expected.revision < Long.MAX_VALUE)
        return save(expected, expected.copy(operation = op.copy(attemptRevision = expected.revision + 1)))
    }
    /** Clears exactly [expected]'s unaccepted operation. Only the transport's locked by-key absence read calls this. */
    @Synchronized internal fun close(expected: FreeBasePurchaseJournal): FreeBasePurchaseJournal {
        check(requireNotNull(expected.operation).receipt == null)
        return save(expected, expected.copy(operation = null))
    }
    @Synchronized internal fun accept(command: FreeBasePurchaseCommand, receipt: FreeBasePurchaseReceipt): FreeBasePurchaseJournal {
        receipt.validate(identity, command); val saved = read(); val op = requireNotNull(saved.operation)
        check(op.command == command); op.receipt?.let { check(it == receipt) { "The original purchase receipt changed." }; return saved }
        return save(saved, saved.copy(operation = op.copy(receipt = receipt)))
    }
}
