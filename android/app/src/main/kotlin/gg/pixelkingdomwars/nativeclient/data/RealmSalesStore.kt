package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.realmsales.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.RealmSaleFailureCrypto
import gg.pixelkingdomwars.nativeclient.wallet.RealmSaleFailureTrust
import gg.pixelkingdomwars.nativeclient.wallet.RealmSaleSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.RealmSaleSettlementVerifier
import gg.pixelkingdomwars.nativeclient.wallet.RealmSaleSigningPolicy
import gg.pixelkingdomwars.nativeclient.wallet.RealmSaleTransaction
import java.security.MessageDigest
import java.util.Base64
import java.util.Collections
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val realmSalesStoreJson = Json { encodeDefaults = true }
// Technical encrypted-document limits, not gameplay policy. At capacity new intent
// fails closed; existing history is never trimmed or overwritten to create space.
private const val maxDocumentChars = 4 * 1024 * 1024
private const val maxArchiveChars = 64 * 1024
private const val maxArchives = 64
private const val maxRevision = 9_007_199_254_740_991L

@Serializable data class RealmSalesSavedPolicy(val protocol: RealmSalesProtocolPolicy, val kingSpots: Int, val regularRealmCount: Int) {
    fun signing() = RealmSaleSigningPolicy(protocol, kingSpots, regularRealmCount).also { it.validate() }
    companion object { fun from(raw: JsonObject): RealmSalesSavedPolicy {
        val values = raw.toMutableMap()
        fun take(key: String): Int { val n = requireNotNull(values.remove(key)) as? JsonPrimitive; require(n != null && !n.isString); return requireNotNull(n.intOrNull) }
        val kings = take("kingSpots"); val regular = take("regularRealmCount")
        return RealmSalesSavedPolicy(RealmSalesProtocolPolicy.from(JsonObject(values)), kings, regular).also { it.signing() }
    } }
}
@Serializable data class RealmSalesSavedSignature(val wire: String, val signature: String)
@Serializable data class RealmSalesSavedSettlement(val wire: RealmSaleSignedWire, val value: RealmSaleSettlement)
@Serializable data class RealmSalesFailurePins(val genesisHash: String, val programId: String, val developer: String,
    val reviewedProgramDataSha256: String, val reviewedDeploymentSlot: Long, val revision: String, val upgradeAuthority: String?) {
    fun trust() = RealmSaleFailureTrust(RealmSaleSigningTrust(genesisHash, programId, developer, reviewedProgramDataSha256, reviewedDeploymentSlot, revision), upgradeAuthority)
    companion object { fun from(t: RealmSaleFailureTrust) = RealmSalesFailurePins(t.signing.genesisHash, t.signing.programId, t.signing.developer,
        t.signing.reviewedProgramDataSha256, t.signing.reviewedDeploymentSlot, t.signing.revision, t.upgradeAuthority) }
}
@Serializable data class RealmSalesSavedFailure(val wire: RealmSaleSignedWire, val value: RealmSaleFailure, val pins: RealmSalesFailurePins)
@Serializable data class RealmSalesObservation(val settlement: Boolean, val failure: Boolean, val preparation: Boolean, val unknown: Boolean)
@Serializable data class RealmSalesOperation(val request: RealmSalePrepareRequest, val policy: RealmSalesSavedPolicy,
    val prepareAttempted: Boolean, val preparation: RealmSalePreparation?, val signingStarted: Boolean,
    val signed: RealmSalesSavedSignature?, val submitAttempted: Boolean, val settlementObserved: Boolean,
    val settlement: RealmSalesSavedSettlement?,
    val prepareRefusal: RealmSalePrepareRefusal? = null, val refusalConfirmedAbsent: Boolean = false, val refusalContradicted: Boolean = false,
    val failureObserved: Boolean = false, val failure: RealmSalesSavedFailure? = null, val wireMetadata: RealmSaleSignedWire? = null,
    /** Dead-end audit 2026-10-06: an attempted prepare with no answer and no refusal, whose two by-key GETs were
     * both explicitly absent in one action. Absent in older document bytes. */
    val attemptConfirmedAbsent: Boolean = false)
@Serializable data class RealmSalesArchive(val version: Int, val identity: StarterIdentity, val revision: Long,
    val previousKey: String?, val operation: RealmSalesOperation)
data class RealmSalesJournal(val version: Int, val identity: StarterIdentity, val revision: Long,
    val operation: RealmSalesOperation?, val lastArchivedKey: String?, val archiveKeys: List<String>, val settlementHeld: Boolean)
@Serializable private data class RealmSalesDocument(val version: Int, val identity: StarterIdentity, val revision: Long,
    val operation: RealmSalesOperation?, val lastArchivedKey: String?, val archives: Map<String, String>,
    val observations: Map<String, RealmSalesObservation> = emptyMap())

/** One native API origin/cluster/wallet owns one encrypted document. SecretStore.write
 * must atomically replace that document, as EncryptedStore does with fsync+rename.
 * All instances for that identity share a process-wide update lock; no cross-file
 * transaction is invented. Archive and clear active happen in one replacement.
 * Ordinary reads verify active evidence and any specifically latched historical
 * key; archived(key) verifies one bounded immutable record. Evidence methods ignore caller cancellation until durable retain. */
class RealmSalesStore(private val secret: SecretStore, val identity: StarterIdentity, failureTrust: RealmSaleFailureTrust? = null) {
    private val failurePins = failureTrust?.let { it.copy(signing = it.signing.copy()) }
    private class Locks { val requests = Mutex(); val updates = Mutex(); val held = mutableSetOf<String>(); val prepared = mutableSetOf<String>(); val failed = mutableSetOf<String>(); val unknown = mutableSetOf<String>() }
    companion object {
        private val identities = mutableMapOf<StarterIdentity, Locks>()
        @Synchronized private fun locks(identity: StarterIdentity) = identities.getOrPut(identity) { Locks() }
    }
    private val shared = locks(identity)
    val requests get() = shared.requests
    init { identity.validate(); require(identity.origin.startsWith("https://") && identity.origin.length <= 2048) }
    private data class Snapshot(val raw: String?, val document: RealmSalesDocument, val journal: RealmSalesJournal)
    private data class Original(val operation: RealmSalesOperation, val archived: Boolean)
    private fun key(value: String) {
        require(value.length == 36 && (value.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) ||
            value == "00000000-0000-0000-0000-000000000000" || value == "ffffffff-ffff-ffff-ffff-ffffffffffff"))
    }
    /** Latch only evidence already attributed to this wallet/original key. These
     * synchronous guards precede storage, parsing, crypto and any suspended effect. */
    fun observeSettlementKey(id: String) { key(id); synchronized(shared) { shared.held += id } }
    fun observeFailureKey(id: String) { key(id); synchronized(shared) { shared.failed += id } }
    fun observeUnknownKey(id: String) { key(id); synchronized(shared) { shared.unknown += id } }
    fun observePreparationKey(id: String) { key(id); synchronized(shared) { shared.prepared += id } }
    private fun held(op: RealmSalesOperation?) = synchronized(shared) {
        shared.held.isNotEmpty() || shared.failed.isNotEmpty() || shared.unknown.isNotEmpty() ||
            shared.prepared.any { it != op?.request?.idempotencyKey || op.prepareRefusal != null } ||
            op?.let { it.settlementObserved || it.failureObserved || it.refusalContradicted } == true
    }
    private fun journal(d: RealmSalesDocument) = RealmSalesJournal(d.version, d.identity, d.revision, d.operation, d.lastArchivedKey,
        Collections.unmodifiableList(d.archives.keys.sorted()), held(d.operation))
    private fun releaseArchive(op: RealmSalesOperation) = synchronized(shared) {
        val id = op.request.idempotencyKey
        val covered = id !in shared.unknown && if (op.failure != null) id !in shared.held else op.settlement != null && id !in shared.failed
        if (covered) { shared.held -= id; shared.failed -= id; shared.prepared -= id }
    }
    private fun flush(s: Snapshot): Snapshot = synchronized(shared) {
        val keys = shared.held + shared.failed + shared.unknown + shared.prepared.filter { it != s.document.operation?.request?.idempotencyKey || s.document.operation.prepareRefusal != null }
        require(keys.size <= maxArchives + 1) { "Unresolved observation storage is full" }
        val values = keys.associateWith { RealmSalesObservation(it in shared.held, it in shared.failed, it in shared.prepared, it in shared.unknown) }
        if (values == s.document.observations) s.copy(journal = journal(s.document)) else save(s, s.document.copy(observations = values))
    }
    private suspend fun operation(value: RealmSalesOperation): RealmSalesOperation {
        val policy = value.policy.signing(); value.request.validate(policy.protocol)
        value.prepareRefusal?.let { it.validate(); require(value.prepareAttempted) }
        require(!value.refusalConfirmedAbsent || value.prepareRefusal != null)
        require(!value.refusalContradicted || value.prepareRefusal != null)
        require(!value.attemptConfirmedAbsent || unanswered(value))
        val p = value.preparation?.let { it.copy(quote = it.quote.copy(rents = Collections.unmodifiableList(ArrayList(it.quote.rents)))) }
        p?.let { it.validate(policy.protocol); require(value.prepareAttempted && it.wallet == identity.wallet && it.idempotencyKey == value.request.idempotencyKey && it.spot == value.request.spot && it.realm == value.request.realm) }
        require(!value.signingStarted || p != null)
        value.signed?.let {
            require(value.signingStarted); val verified = RealmSaleTransaction.verifySigned(requireNotNull(p), policy, it.wire)
            require(verified.signature == it.signature)
        }
        require(!value.submitAttempted || value.signed != null)
        value.wireMetadata?.let { w ->
            w.validate(); require(p != null && w.wallet == identity.wallet && w.idempotencyKey == value.request.idempotencyKey && w.saleId == p.saleId && w.messageSha256 == p.quote.messageSha256)
            val bytes = hex(w.signedTransactionHex); require(hash(bytes) == w.wireSha256)
            require(value.signed?.wire == Base64.getEncoder().encodeToString(bytes) && value.signed.signature == w.signature)
        }
        val settlement = value.settlement?.let { evidence ->
            require(value.settlementObserved); val signed = requireNotNull(value.signed)
            require(Base64.getEncoder().encodeToString(hex(evidence.wire.signedTransactionHex)) == signed.wire && evidence.wire.signature == signed.signature)
            RealmSalesSavedSettlement(evidence.wire, RealmSaleSettlementVerifier.verify(requireNotNull(p), evidence.wire, evidence.value, policy))
        }
        val failure = value.failure?.let { evidence ->
            require(value.failureObserved && settlement == null)
            val signed = requireNotNull(value.signed)
            require(Base64.getEncoder().encodeToString(hex(evidence.wire.signedTransactionHex)) == signed.wire && evidence.wire.signature == signed.signature)
            val pins = requireNotNull(failurePins) { "Historical failure deployment pins are unavailable" }
            require(evidence.pins.trust() == pins) { "Saved failure pins differ from independent history pins" }
            evidence.copy(value = RealmSaleFailureCrypto.bind(requireNotNull(p), evidence.wire, evidence.value, pins, policy).failure)
        }
        return value.copy(preparation = p, settlement = settlement, failure = failure)
    }
    private fun envelope(raw: JsonObject) {
        require(raw.keys == setOf("version", "identity", "revision", "operation", "lastArchivedKey", "archives") ||
            raw.keys == setOf("version", "identity", "revision", "operation", "lastArchivedKey", "archives", "observations"))
        raw["observations"]?.jsonObject?.let { values ->
            require(values.size <= maxArchives + 1)
            values.forEach { (id, value) -> key(id); copyBounded(value); strict(value, RealmSalesObservation.serializer().descriptor) }
        }
        val archives = raw.getValue("archives").jsonObject; require(archives.size <= maxArchives)
        archives.forEach { (k, v) -> key(k); require(v is JsonPrimitive && v.isString && v.content.length in 1..maxArchiveChars) }
        copyBounded(JsonObject(raw - "archives" - "observations"))
        strict(raw, RealmSalesDocument.serializer().descriptor)
    }
    private suspend fun snapshot(): Snapshot {
        val raw = secret.read()
        val d = if (raw == null) RealmSalesDocument(1, identity, 0, null, null, emptyMap()) else {
            require(raw.length in 1..maxDocumentChars); val parsed = realmSalesStoreJson.parseToJsonElement(raw).jsonObject
            envelope(parsed); realmSalesStoreJson.decodeFromJsonElement(RealmSalesDocument.serializer(), parsed)
        }
        require(d.version == 1 && d.identity == identity && d.revision in 0..maxRevision)
        require(d.archives.size.toLong() <= d.revision)
        require(d.revision > 0 || d.operation == null && d.archives.isEmpty() && d.lastArchivedKey == null)
        d.lastArchivedKey?.let { key(it); require(it in d.archives) }; require(d.archives.isEmpty() == (d.lastArchivedKey == null))
        require(d.operation?.request?.idempotencyKey !in d.archives)
        val owned = d.copy(operation = d.operation?.let { operation(it) }, archives = Collections.unmodifiableMap(LinkedHashMap(d.archives)))
        require(d.observations.size <= maxArchives + 1)
        for ((id, observation) in d.observations) {
            key(id); require(observation.settlement || observation.failure || observation.preparation || observation.unknown)
            if (observation.settlement) observeSettlementKey(id)
            if (observation.failure) observeFailureKey(id)
            if (observation.preparation) observePreparationKey(id)
            if (observation.unknown) observeUnknownKey(id)
        }
        if (owned.operation?.failureObserved == true) observeFailureKey(owned.operation.request.idempotencyKey)
        val captured = Snapshot(raw, owned, journal(owned))
        try {
            val keys = synchronized(shared) { (shared.held + shared.failed + shared.prepared + shared.unknown).toList() }
            for (id in keys) if (id in owned.archives) releaseArchive(requireNotNull(archived(owned, id)).operation)
        } catch (error: Exception) {
            try { flush(captured) } catch (storage: Exception) { if (storage !== error) error.addSuppressed(storage) }; throw error
        }
        return flush(captured)
    }
    private suspend fun archived(d: RealmSalesDocument, id: String): RealmSalesArchive? {
        key(id); val text = d.archives[id] ?: return null
        val raw = copyBounded(realmSalesStoreJson.parseToJsonElement(text)).jsonObject
        strict(raw, RealmSalesArchive.serializer().descriptor)
        val value = realmSalesStoreJson.decodeFromJsonElement(RealmSalesArchive.serializer(), raw)
        require(value.version == 1 && value.identity == identity && value.revision in 1..d.revision)
        value.previousKey?.let { key(it); require(it != id && it in d.archives) }
        require(value.operation.request.idempotencyKey == id && (value.operation.settlement != null || value.operation.failure != null || refusedAndAbsent(value.operation) || unansweredAndAbsent(value.operation)))
        return value.copy(operation = operation(value.operation))
    }
    private fun unsignedRefusal(op: RealmSalesOperation) = op.prepareRefusal != null && op.prepareAttempted && op.preparation == null &&
        !op.signingStarted && op.signed == null && !op.submitAttempted && !op.settlementObserved && op.settlement == null && !op.failureObserved && op.failure == null && !op.refusalContradicted
    private fun refusedAndAbsent(op: RealmSalesOperation) = op.refusalConfirmedAbsent && unsignedRefusal(op)
    /** An attempted prepare that never produced a preparation, a refusal or any later effect. */
    private fun unanswered(op: RealmSalesOperation) = op.prepareRefusal == null && op.prepareAttempted && op.preparation == null &&
        !op.signingStarted && op.signed == null && !op.submitAttempted && !op.settlementObserved && op.settlement == null &&
        !op.failureObserved && op.failure == null && !op.refusalContradicted && op.wireMetadata == null && !op.refusalConfirmedAbsent
    private fun unansweredAndAbsent(op: RealmSalesOperation) = op.attemptConfirmedAbsent && unanswered(op)
    private suspend fun original(s: Snapshot, id: String): Original {
        key(id); s.document.operation?.takeIf { it.request.idempotencyKey == id }?.let { return Original(it, false) }
        return Original(requireNotNull(archived(s.document, id)) { "No original realm-sale request is retained" }.operation, true)
    }
    private fun save(s: Snapshot, next: RealmSalesDocument, guard: () -> Unit = {}): Snapshot = synchronized(shared) {
        check(s.document.revision < maxRevision && secret.read() == s.raw) { "Original realm sale changed during verification" }
        guard()
        val d = next.copy(revision = s.document.revision + 1)
        val text = realmSalesStoreJson.encodeToString(RealmSalesDocument.serializer(), d)
        require(text.length <= maxDocumentChars); secret.write(text)
        Snapshot(text, d, journal(d))
    }
    private fun expected(s: Snapshot, expected: RealmSalesJournal) { check(s.journal == expected) { "Read the latest original realm sale" } }
    suspend fun read(): RealmSalesJournal = shared.updates.withLock { snapshot().journal }
    suspend fun archived(id: String): RealmSalesArchive? = shared.updates.withLock {
        val s = snapshot()
        try { archived(s.document, id)?.also { releaseArchive(it.operation) } } finally { flush(s) }
    }
    suspend fun effectGuard(expected: RealmSalesJournal): () -> Unit = shared.updates.withLock {
        val s = snapshot(); expected(s, expected); check(!s.journal.settlementHeld)
        val checkHeld: () -> Unit = { check(!held(s.document.operation)) { "Observed realm-sale evidence requires recovery" } }
        checkHeld
    }
    suspend fun begin(expected: RealmSalesJournal, request: RealmSalePrepareRequest, policy: RealmSalesSavedPolicy): RealmSalesJournal = shared.updates.withLock {
        val s = snapshot(); expected(s, expected); check(s.document.operation == null && !s.journal.settlementHeld)
        policy.signing(); request.validate(policy.protocol); check(request.idempotencyKey !in s.document.archives)
        require(s.document.archives.size < maxArchives && (s.raw?.length ?: 0) + 2 * maxArchiveChars <= maxDocumentChars) { "Realm-sale recovery storage is full; retained history remains available" }
        save(s, s.document.copy(operation = RealmSalesOperation(request, policy, false, null, false, null, false, false, null))).journal
    }
    suspend fun prepareAttempt(expected: RealmSalesJournal): RealmSalesJournal = shared.updates.withLock {
        val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation)
        check(!op.prepareAttempted && op.preparation == null && !s.journal.settlementHeld)
        save(s, s.document.copy(operation = op.copy(prepareAttempted = true))).journal
    }
    suspend fun acceptPrepareRefusal(id: String, refusal: RealmSalePrepareRefusal): RealmSalesJournal = withContext(NonCancellable) { shared.updates.withLock {
        key(id); refusal.validate(); val s = snapshot(); val found = original(s, id); val op = found.operation
        if (op.prepareRefusal != null) { check(op.prepareRefusal == refusal); return@withLock s.journal }
        check(!found.archived && op.prepareAttempted && op.preparation == null && !op.signingStarted && op.signed == null &&
            !op.submitAttempted && !op.settlementObserved && op.settlement == null && !s.journal.settlementHeld && id !in shared.prepared)
        save(s, s.document.copy(operation = op.copy(prepareRefusal = refusal))).journal
    } }
    /** Attributed non-null preparation/wire is latched before fallible reads or
     * nested decoding. It cannot be contradicted later by a first refusal. */
    private suspend fun preparationObserved(id: String): Snapshot {
        observePreparationKey(id)
        val s = snapshot(); val found = original(s, id); val op = found.operation
        if (op.prepareRefusal == null) return s
        observeSettlementKey(id)
        if (found.archived || op.refusalContradicted) return s.copy(journal = journal(s.document))
        return save(s, s.document.copy(operation = op.copy(refusalContradicted = true)))
    }
    suspend fun observePreparation(id: String): RealmSalesJournal {
        observePreparationKey(id)
        return withContext(NonCancellable) { shared.updates.withLock { preparationObserved(id).journal } }
    }
    /** Repository calls this only after both fresh original authenticated GETs
     * explicitly returned absence. The following archive is still CAS guarded. */
    suspend fun confirmRefusalAbsent(expected: RealmSalesJournal): RealmSalesJournal = shared.updates.withLock {
        val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation)
        check(unsignedRefusal(op) && !s.journal.settlementHeld)
        save(s, s.document.copy(operation = op.copy(refusalConfirmedAbsent = true))).journal
    }
    /** Dead-end audit 2026-10-06 (shape A). Repository calls this only after both fresh original by-key GETs in
     * the same action explicitly returned absence for this key. No observed preparation for it may exist. */
    suspend fun confirmAttemptAbsent(expected: RealmSalesJournal): RealmSalesJournal = shared.updates.withLock {
        val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation)
        check(unanswered(op) && !s.journal.settlementHeld && !held(op) && synchronized(shared) { op.request.idempotencyKey !in shared.prepared }) {
            "This purchase request has server evidence; it stays open." }
        save(s, s.document.copy(operation = op.copy(attemptConfirmedAbsent = true))).journal
    }
    suspend fun acceptPreparation(id: String, preparation: RealmSalePreparation): RealmSalesJournal {
        // Capture mutable lists before acquiring a potentially suspended identity lock.
        require(preparation.quote.rents.size in 1..3)
        val p = preparation.copy(quote = preparation.quote.copy(rents = Collections.unmodifiableList(ArrayList(preparation.quote.rents))))
        return withContext(NonCancellable) { shared.updates.withLock {
            val s = preparationObserved(id); val found = original(s, id); val op = found.operation
            p.validate(op.policy.protocol); require(op.prepareAttempted && p.wallet == identity.wallet && p.idempotencyKey == id && p.spot == op.request.spot && p.realm == op.request.realm)
            if (op.preparation != null) { check(op.preparation == p); return@withLock s.journal }
            check(!found.archived); save(s, s.document.copy(operation = op.copy(preparation = p))).journal
        } }
    }
    suspend fun signingAttempt(expected: RealmSalesJournal): RealmSalesJournal = shared.updates.withLock {
        val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation)
        check(op.prepareRefusal == null && op.preparation != null && !op.signingStarted && op.signed == null && !s.journal.settlementHeld)
        save(s, s.document.copy(operation = op.copy(signingStarted = true))).journal
    }
    private suspend fun signed(s: Snapshot, id: String, wire: String): Snapshot {
        val found = original(s, id); val op = found.operation; check(op.signingStarted)
        val verified = RealmSaleTransaction.verifySigned(requireNotNull(op.preparation), op.policy.signing(), wire)
        val saved = RealmSalesSavedSignature(verified.wire, verified.signature)
        if (op.signed != null) { check(op.signed == saved); return s }
        check(!found.archived); return save(s, s.document.copy(operation = op.copy(signed = saved)))
    }
    suspend fun acceptSigned(id: String, wire: String): RealmSalesJournal = withContext(NonCancellable) { shared.updates.withLock { signed(snapshot(), id, wire).journal } }
    suspend fun submitAttempt(expected: RealmSalesJournal): RealmSalesJournal = shared.updates.withLock {
        val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation)
        check(op.prepareRefusal == null && op.signed != null && !op.submitAttempted && !s.journal.settlementHeld)
        save(s, s.document.copy(operation = op.copy(submitAttempted = true))).journal
    }
    private suspend fun observed(id: String): Snapshot {
        // The caller attributed this positive response to the identity-scoped key.
        // Latch it before any read/decryption/verification can fail. A declined
        // archive keeps the identity held; a verified paid archive releases its own latch.
        key(id); observeSettlementKey(id)
        val s = snapshot()
        val found = original(s, id)
        if (found.archived) { releaseArchive(found.operation); return flush(s) }
        if (found.operation.settlementObserved) return s
        return save(s, s.document.copy(operation = found.operation.copy(settlementObserved = true)))
    }
    suspend fun observeSettlement(id: String): RealmSalesJournal {
        observeSettlementKey(id)
        return withContext(NonCancellable) { shared.updates.withLock { observed(id).journal } }
    }
    suspend fun observeFailure(id: String): RealmSalesJournal {
        observeFailureKey(id)
        return withContext(NonCancellable) { shared.updates.withLock {
            val s = snapshot(); val found = original(s, id)
            if (found.archived || found.operation.failureObserved) s.journal
            else save(s, s.document.copy(operation = found.operation.copy(failureObserved = true))).journal
        } }
    }
    suspend fun acceptSavedWire(id: String, raw: JsonElement): RealmSalesJournal {
        val input = copyBounded(raw)
        return withContext(NonCancellable) { shared.updates.withLock { retainWire(snapshot(), id, input.jsonObject).journal } }
    }
    private suspend fun retainWire(s: Snapshot, id: String, raw: JsonObject): Snapshot {
        val w = RealmSaleSignedWire.from(raw); val op = original(s, id).operation; val p = requireNotNull(op.preparation)
        require(w.wallet == identity.wallet && w.idempotencyKey == id && w.saleId == p.saleId && w.messageSha256 == p.quote.messageSha256)
        val bytes = hex(w.signedTransactionHex); require(hash(bytes) == w.wireSha256)
        val verified = RealmSaleTransaction.verifySigned(p, op.policy.signing(), Base64.getEncoder().encodeToString(bytes)); require(verified.signature == w.signature)
        val saved = signed(s, id, verified.wire); val latest = original(saved, id)
        latest.operation.wireMetadata?.let { check(it == w); return saved }
        check(!latest.archived)
        return save(saved, saved.document.copy(operation = latest.operation.copy(wireMetadata = w)))
    }
    suspend fun acceptFailure(id: String, wireRaw: JsonElement, failureRaw: JsonElement): RealmSalesJournal {
        observeFailureKey(id)
        val wireInput = runCatching { copyBounded(wireRaw) }; val failureInput = runCatching { copyBounded(failureRaw) }
        return try { withContext(NonCancellable) {
            observeFailure(id)
            shared.updates.withLock {
                var s = snapshot(); s = retainWire(s, id, wireInput.getOrThrow().jsonObject)
                val found = original(s, id); val op = found.operation; val p = requireNotNull(op.preparation)
                val w = RealmSaleSignedWire.from(wireInput.getOrThrow().jsonObject)
                val f = RealmSaleFailure.from(p, w, failureInput.getOrThrow().jsonObject, op.policy.protocol)
                val pins = requireNotNull(failurePins) { "Historical failure deployment pins are unavailable" }
                val evidence = RealmSalesSavedFailure(w, RealmSaleFailureCrypto.bind(p, w, f, pins, op.policy.signing()).failure, RealmSalesFailurePins.from(pins))
                check(op.settlement == null) { "Conflicting paid and failed realm-sale evidence" }
                if (op.failure != null) { check(op.failure == evidence); return@withLock s.journal }
                check(!found.archived); save(s, s.document.copy(operation = op.copy(failure = evidence))).journal
            }
        } } catch (error: Exception) {
            // Changed, malformed or unverifiable adjacent evidence cannot be
            // forgotten by replaying an older accepted failure after restart.
            observeUnknownKey(id)
            try { withContext(NonCancellable) { read() } } catch (storage: Exception) { if (storage !== error) error.addSuppressed(storage) }
            throw error
        }
    }
    private fun failedArchiveGuard(op: RealmSalesOperation) = synchronized(shared) {
        check(op.failure != null && op.settlement == null && !op.settlementObserved && op.signed != null)
        check(shared.held.isEmpty() && shared.unknown.isEmpty() && shared.failed.all { it == op.request.idempotencyKey } &&
            shared.prepared.all { it == op.request.idempotencyKey }) { "Conflicting realm-sale observations remain held" }
    }
    suspend fun archiveFailed(expected: RealmSalesJournal, fresh: RealmSaleFailure, guard: () -> Unit = {}): RealmSalesJournal {
        require(fresh.receipt.source.accounts.size == 3)
        val owned = fresh.copy(receipt = fresh.receipt.copy(source = fresh.receipt.source.copy(accounts = Collections.unmodifiableList(ArrayList(fresh.receipt.source.accounts)))))
        return shared.updates.withLock {
        val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation); failedArchiveGuard(op)
        val saved = requireNotNull(op.failure)
        val checked = RealmSaleFailureCrypto.bind(requireNotNull(op.preparation), saved.wire, owned, requireNotNull(failurePins), op.policy.signing()).failure
        require(checked == saved.value) { "Fresh failed-execution evidence differs" }
        archive(s, op) { guard(); failedArchiveGuard(op) }
        }
    }
    /** Caller has already attributed a positive owner response to this original key.
     * Malformed adjacent wire/receipt fields cannot suppress the durable hold. A valid
     * original wire is retained before later receipt validation can fail. */
    suspend fun acceptSettlement(id: String, wireRaw: JsonElement, settlementRaw: JsonElement): RealmSalesJournal {
        observeSettlementKey(id)
        val wireInput = runCatching { copyBounded(wireRaw) }; val receiptInput = runCatching { copyBounded(settlementRaw) }
        return withContext(NonCancellable) { shared.updates.withLock {
            var s = observed(id)
            val wire = RealmSaleSignedWire.from(wireInput.getOrThrow().jsonObject)
            val op = original(s, id).operation; val p = requireNotNull(op.preparation)
            require(wire.wallet == identity.wallet && wire.idempotencyKey == id && wire.saleId == p.saleId && wire.messageSha256 == p.quote.messageSha256)
            val bytes = hex(wire.signedTransactionHex); require(hash(bytes) == wire.wireSha256)
            s = signed(s, id, Base64.getEncoder().encodeToString(bytes))
            val value = RealmSaleSettlement.from(p, wire, receiptInput.getOrThrow().jsonObject, op.policy.protocol)
            val evidence = RealmSalesSavedSettlement(wire, RealmSaleSettlementVerifier.verify(p, wire, value, op.policy.signing()))
            val latest = original(s, id)
            if (latest.operation.settlement != null) { check(latest.operation.settlement == evidence); return@withLock s.journal }
            check(!latest.archived && latest.operation.failure == null); save(s, s.document.copy(operation = latest.operation.copy(settlement = evidence))).journal
        } }
    }
    suspend fun archive(expected: RealmSalesJournal): RealmSalesJournal = shared.updates.withLock {
        val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation)
        fun eligible() = synchronized(shared) {
            check(!op.failureObserved && op.failure == null && shared.failed.isEmpty() && shared.unknown.isEmpty())
            check(op.settlement != null && op.settlementObserved && op.signed != null || refusedAndAbsent(op) && !held(op) ||
                unansweredAndAbsent(op) && !held(op) && op.request.idempotencyKey !in shared.prepared)
            check(shared.held.all { it == op.request.idempotencyKey } && shared.prepared.all { it == op.request.idempotencyKey })
        }
        eligible(); archive(s, op, ::eligible)
    }
    private fun archive(s: Snapshot, op: RealmSalesOperation, guard: () -> Unit): RealmSalesJournal {
        val id = op.request.idempotencyKey; check(id !in s.document.archives && s.document.archives.size < maxArchives)
        val record = RealmSalesArchive(1, identity, s.document.revision, s.document.lastArchivedKey, op)
        val encoded = realmSalesStoreJson.encodeToString(RealmSalesArchive.serializer(), record); require(encoded.length <= maxArchiveChars)
        val saved = save(s, s.document.copy(operation = null, lastArchivedKey = id, archives = s.document.archives + (id to encoded), observations = s.document.observations - id), guard)
        releaseArchive(op); return flush(saved).journal
    }

}

/** Deep copy and bounds happen before suspend, schema decoding, or crypto. */
private fun copyBounded(raw: JsonElement): JsonElement {
    var nodes = 0
    fun copy(value: JsonElement, depth: Int): JsonElement {
        require(++nodes <= 768 && depth <= 12)
        return when (value) {
            is JsonObject -> { require(value.size <= 40); JsonObject(value.entries.associate { (k, v) -> require(k.length <= 64); k to copy(v, depth + 1) }) }
            is JsonArray -> { require(value.size <= 6); JsonArray(value.map { copy(it, depth + 1) }) }
            is JsonPrimitive -> value.also { require(it.content.length <= 2464) }
        }
    }
    return copy(raw, 0)
}
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
private fun strict(raw: JsonElement, schema: kotlinx.serialization.descriptors.SerialDescriptor) {
    if (raw == JsonNull) { require(schema.isNullable); return }
    when (schema.kind) {
        kotlinx.serialization.descriptors.StructureKind.CLASS -> { val v = raw.jsonObject; for (i in 0 until schema.elementsCount) v[schema.getElementName(i)]?.let { strict(it, schema.getElementDescriptor(i)) } }
        kotlinx.serialization.descriptors.StructureKind.LIST -> raw.jsonArray.forEach { strict(it, schema.getElementDescriptor(0)) }
        kotlinx.serialization.descriptors.PrimitiveKind.STRING -> require(raw.jsonPrimitive.isString)
        kotlinx.serialization.descriptors.PrimitiveKind.BOOLEAN -> require(!raw.jsonPrimitive.isString && raw.jsonPrimitive.booleanOrNull != null)
        kotlinx.serialization.descriptors.PrimitiveKind.INT, kotlinx.serialization.descriptors.PrimitiveKind.LONG -> require(!raw.jsonPrimitive.isString && raw.jsonPrimitive.longOrNull != null)
        else -> Unit
    }
}
private fun hex(value: String): ByteArray {
    require(value.length in 132..2464 && value.matches(Regex("(?:[0-9a-f]{2})+")))
    return ByteArray(value.length / 2) { value.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
