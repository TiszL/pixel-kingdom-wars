package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.Base64
import java.util.Collections
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val taxStoreJson = Json { encodeDefaults = true }
// Technical storage bounds. Full history is never trimmed to admit a new claim.
private const val taxDocumentChars = 8 * 1024 * 1024
private const val taxArchiveChars = 128 * 1024
private const val taxArchives = 64
private const val taxRevisionMax = 9_007_199_254_740_991L

@Serializable data class MiningTaxClaimsSavedTrust(val genesisHash: String, val programId: String, val configAddress: String,
    val keepMint: String, val reserveOwner: String, val reviewedDeploymentSlot: Long, val reviewedProgramDataSha256: String) {
    companion object { fun from(t: MiningTaxClaimsSigningTrust) = MiningTaxClaimsSavedTrust(t.genesisHash, t.programId, t.configAddress, t.keepMint, t.reserveOwner, t.reviewedDeploymentSlot, t.reviewedProgramDataSha256) }
}
@Serializable data class MiningTaxClaimsSavedWire(val ordinal: Int, val wire: String, val signature: String, val messageSha256: String, val wireSha256: String) {
    fun local() = MiningTaxClaimsLocalWire(ordinal, wire, signature, messageSha256, wireSha256)
    companion object { fun from(w: SignedMiningTaxClaims) = MiningTaxClaimsSavedWire(w.ordinal, w.wire, w.signature, w.messageSha256, w.wireSha256) }
}
@Serializable data class MiningTaxClaimsCustody(val ordinal: Int, val signingStarted: Boolean, val signed: MiningTaxClaimsSavedWire?, val submitAttempted: Boolean)
@Serializable data class MiningTaxClaimsContinuationIntent(val request: MiningTaxClaimsContinuationRequest, val attempted: Boolean,
    val envelope: MiningTaxClaimsContinuationEnvelope?)
@Serializable data class MiningTaxClaimsOperation(val request: MiningTaxClaimsPrepareRequest, val trust: MiningTaxClaimsSavedTrust,
    val daySec: Long, val prepareAttempted: Boolean, val preparation: MiningTaxClaimsPreparation?,
    val transactions: List<MiningTaxClaimsCustody>, val observed: List<Int>, val unattributedObserved: Boolean,
    val setup: MiningTaxClaimsRecoveryEnvelope?, val settlement: MiningTaxClaimsRecoveryEnvelope?,
    val failure: MiningTaxClaimsFailureEnvelope? = null, val failureObserved: Boolean = false,
    val continuation: MiningTaxClaimsContinuationIntent? = null, val continuationObserved: Boolean = false,
    // Dead-end audit 2026-10-06: archived only after a fresh by-key prepare read answered `unknown`. Older bytes
    // without this field are normalised by legacyTaxOperation, so they keep decoding unchanged.
    val absenceConfirmed: Boolean = false)
@Serializable data class MiningTaxClaimsArchive(val version: Int, val identity: StarterIdentity, val revision: Long,
    val previousKey: String?, val operation: MiningTaxClaimsOperation)
data class MiningTaxClaimsJournal(val version: Int, val identity: StarterIdentity, val revision: Long,
    val operation: MiningTaxClaimsOperation?, val lastArchivedKey: String?, val archiveKeys: List<String>, val settlementHeld: Boolean)
@Serializable private data class MiningTaxClaimsArchiveHold(val observed: List<Int>, val unattributedObserved: Boolean, val failureObserved: Boolean,
    val continuationObserved: Boolean = false)
@Serializable private data class MiningTaxClaimsDocument(val version: Int, val identity: StarterIdentity, val revision: Long,
    val operation: MiningTaxClaimsOperation?, val lastArchivedKey: String?, val archives: Map<String, String>,
    val heldArchives: Map<String, MiningTaxClaimsArchiveHold> = emptyMap())

/** One encrypted document per origin/cluster/wallet. SecretStore must atomically
 * replace it (the device EncryptedStore uses fsync+rename). Archive and active
 * removal are a single replacement. Identity locks coordinate instances in this
 * process; raw/revision CAS rejects a changed document after crypto validation.
 * This store has no admission, wallet, HTTP, relay or independent finality port. */
class MiningTaxClaimsStore(private val secret: SecretStore, val identity: StarterIdentity,
    trust: MiningTaxClaimsSigningTrust, policy: MiningTaxClaimsSigningPolicy) {
    private class Locks { val requests = Mutex(); val updates = Mutex(); val holds = mutableMapOf<String, MutableSet<Int?>>(); val failureKeys = mutableSetOf<String>(); val continuationKeys = mutableSetOf<String>() }
    companion object {
        private val identities = mutableMapOf<StarterIdentity, Locks>()
        @Synchronized private fun locks(identity: StarterIdentity) = identities.getOrPut(identity) { Locks() }
    }
    private val pins = trust.copy()
    private val rules = policy.copy().also { it.validate() }
    private val savedTrust = MiningTaxClaimsSavedTrust.from(pins)
    private val shared = locks(identity)
    val requests get() = shared.requests
    init { identity.validate(); require(identity.origin.startsWith("https://") && identity.origin.length <= 2048) }
    private data class Snapshot(val raw: String?, val document: MiningTaxClaimsDocument, val journal: MiningTaxClaimsJournal)
    private data class Original(val operation: MiningTaxClaimsOperation, val archived: Boolean)

    /** Attribute the positive reply before storage/decryption/schema work. The
     * caller must supply the identity-scoped request key, not trust a response key. */
    fun observeSettlementKey(id: String, ordinal: Int? = null) {
        key(id); ordinal?.let(::checkOrdinal)
        synchronized(shared) { shared.holds.getOrPut(id) { mutableSetOf() }.add(ordinal) }
    }
    /** A failure observation blocks every old effect immediately, including claim1
     * after known setup0, before any proof/decryption/storage can suspend or fail. */
    fun observeFailureKey(id: String) {
        key(id); synchronized(shared) { shared.failureKeys.add(id); shared.holds.getOrPut(id) { mutableSetOf() } }
    }
    fun observeContinuationKey(id: String) {
        key(id); synchronized(shared) { shared.continuationKeys.add(id); shared.holds.getOrPut(id) { mutableSetOf() } }
    }
    fun settlementHeld(id: String? = null, ordinal: Int? = null): Boolean {
        id?.let(::key); ordinal?.let(::checkOrdinal)
        return synchronized(shared) {
            if (id == null) shared.holds.isNotEmpty()
            else id in shared.failureKeys || id in shared.continuationKeys || shared.holds[id]?.any { it == null || ordinal == null || it >= ordinal } == true
        }
    }
    private fun heldKeys() = synchronized(shared) { shared.holds.keys.toList() }
    private fun release(id: String) { synchronized(shared) { shared.holds.remove(id); shared.failureKeys.remove(id); shared.continuationKeys.remove(id) } }
    private fun journal(d: MiningTaxClaimsDocument) = MiningTaxClaimsJournal(d.version, d.identity, d.revision, d.operation,
        d.lastArchivedKey, ownTax(d.archives.keys.sorted()), settlementHeld())
    private fun latch(op: MiningTaxClaimsOperation?) {
        if (op == null) return
        if (op.failureObserved || op.failure != null) observeFailureKey(op.request.idempotencyKey)
        if (op.continuationObserved) observeContinuationKey(op.request.idempotencyKey)
        for (ordinal in op.observed) observeSettlementKey(op.request.idempotencyKey, ordinal)
        if (op.unattributedObserved) observeSettlementKey(op.request.idempotencyKey)
    }
    private fun noHeld() { check(!settlementHeld()) { "Positive tax evidence requires recovery" } }
    private fun mayStart(op: MiningTaxClaimsOperation, ordinal: Int) = synchronized(shared) {
        check(shared.failureKeys.isEmpty() && !op.failureObserved) { "Failed tax evidence requires historical recovery" }
        check(shared.continuationKeys.isEmpty() && op.continuation == null && !op.continuationObserved) { "Continue the saved tax intent through its original link" }
        check(shared.holds.keys.none { it != op.request.idempotencyKey }) { "Another tax key has unresolved positive evidence" }
        check(shared.holds[op.request.idempotencyKey]?.none { it == null || it >= ordinal || it < ordinal && op.setup == null } != false) { "Tax evidence holds this transaction" }
        check(op.settlement == null && op.failure == null && (ordinal == 0 || op.setup != null)) { "The next tax transaction requires verified setup" }
    }
    private fun local(op: MiningTaxClaimsOperation) = MiningTaxClaimsLocalEvidence(identity.wallet, op.request, requireNotNull(op.preparation), op.transactions.mapNotNull { it.signed?.local() })
    private suspend fun operation(value: MiningTaxClaimsOperation): MiningTaxClaimsOperation {
        require(value.transactions.size <= 2 && value.observed.size <= 2)
        // ABI spot width, not today's admission policy. A historical request is not re-admitted.
        value.request.validate(256); require(value.trust == savedTrust && value.daySec == rules.daySec)
        val p = value.preparation?.let(::ownTaxPreparation)
        val transactions = ownTax(value.transactions.map { it.copy(signed = it.signed?.copy()) })
        val observed = ownTax(value.observed); observed.forEach(::checkOrdinal)
        require(observed.zipWithNext().all { (a, b) -> a < b })
        require(transactions.zipWithNext().all { (a, b) -> a.ordinal < b.ordinal })
        val op = value.copy(preparation = p, transactions = transactions, observed = observed,
            setup = value.setup?.let(::ownTaxRecovery), settlement = value.settlement?.let(::ownTaxRecovery), failure = value.failure?.let(::ownTaxFailure),
            continuation = value.continuation?.let { it.copy(request = it.request.copy(caps = it.request.caps.copy()), envelope = it.envelope?.let(::ownTaxContinuation)) })
        if (p != null) {
            require(op.prepareAttempted && p.wallet == identity.wallet && op.request == MiningTaxClaimsPrepareRequest(p.idempotencyKey, p.round, p.spot, p.caps))
            MiningTaxClaimsCrypto.prepare(p, pins, rules)
        } else require(transactions.isEmpty() && op.setup == null && op.settlement == null && op.failure == null && op.continuation == null)
        require(!op.absenceConfirmed || p == null && observed.isEmpty() && !op.unattributedObserved && !op.failureObserved && !op.continuationObserved)
        for (t in transactions) {
            checkOrdinal(t.ordinal); require(p != null && t.ordinal in p.transactions.indices && t.signingStarted)
            t.signed?.let { require(it.ordinal == t.ordinal && MiningTaxClaimsSavedWire.from(MiningTaxClaimsCrypto.verifySigned(p, it.wire, rules, t.ordinal)) == it) }
            require(!t.submitAttempted || t.signed != null)
        }
        for ((phase, recovery) in listOf("setup" to op.setup, "settled" to op.settlement)) if (recovery != null) {
            require(recovery.settlement?.ordinal?.toInt() in observed)
            require(MiningTaxClaimsCrypto.bindSettlement(local(op), recovery, pins, rules).phase == phase)
        }
        op.failure?.let { failure ->
            require(op.settlement == null && failure.failures.all { it.ordinal.toInt() in observed })
            MiningTaxClaimsFailureCrypto.bind(local(op), failure, pins, rules)
            op.setup?.let { require(sameTaxEvidence(it, failure.recovery)) }
        }
        op.continuation?.let { continuation ->
            continuation.request.validate(); require(continuation.request.idempotencyKey != op.request.idempotencyKey && p?.transactions?.size == 2 && op.setup != null)
            continuation.envelope?.let {
                require(continuation.attempted && op.continuationObserved)
                MiningTaxClaimsContinuationCrypto.bind(local(op), op.setup, continuation.request, it, pins, rules)
            }
        }
        // Historical failed custody may include claim1 without successful setup;
        // it is evidence only. New ordinal1 effects still require setup in mayStart.
        require(transactions.none { it.ordinal == 1 } || op.setup != null || op.failure?.failures?.any { it.ordinal == 1L } == true)
        return op
    }
    private suspend fun snapshot(): Snapshot {
        val raw = secret.read()
        val d = if (raw == null) MiningTaxClaimsDocument(1, identity, 0, null, null, emptyMap()) else {
            require(raw.length in 1..taxDocumentChars)
            val parsed = taxStoreJson.parseToJsonElement(raw).jsonObject
            val legacyFields = setOf("version", "identity", "revision", "operation", "lastArchivedKey", "archives")
            require(parsed.keys == legacyFields || parsed.keys == legacyFields + "heldArchives")
            val archives = parsed.getValue("archives").jsonObject; require(archives.size <= taxArchives)
            for ((id, text) in archives) { key(id); require(text is JsonPrimitive && text.isString && text.content.length in 1..taxArchiveChars) }
            val held = (parsed["heldArchives"] ?: JsonObject(emptyMap())).jsonObject; require(held.size <= taxArchives)
            for ((id, value) in held) { key(id); require(id in archives); copyTaxBounded(value) }
            copyTaxBounded(JsonObject(parsed - "archives" - "heldArchives"))
            taxStoreJson.decodeFromJsonElement(MiningTaxClaimsDocument.serializer(), parsed).also {
                require(legacyTaxOperation(parsed) == taxStoreJson.encodeToJsonElement(MiningTaxClaimsDocument.serializer(), it)) { "Tax journal scalar shape changed" }
            }
        }
        require(d.version == 1 && d.identity == identity && d.revision in 0..taxRevisionMax && d.archives.size.toLong() <= d.revision)
        require(d.revision > 0 || d.operation == null && d.archives.isEmpty() && d.lastArchivedKey == null)
        d.lastArchivedKey?.let { key(it); require(it in d.archives) }; require(d.archives.isEmpty() == (d.lastArchivedKey == null))
        require(d.operation?.request?.idempotencyKey !in d.archives && d.operation?.absenceConfirmed != true)
        val held = d.heldArchives.mapValues { (id, value) ->
            key(id); require(id in d.archives && value.observed.size <= 2)
            value.observed.forEach(::checkOrdinal); require(value.observed.zipWithNext().all { (a, b) -> a < b })
            require(value.observed.isNotEmpty() || value.unattributedObserved || value.failureObserved || value.continuationObserved)
            value.copy(observed = ownTax(value.observed))
        }
        val owned = d.copy(operation = d.operation?.let { operation(it) }, archives = Collections.unmodifiableMap(LinkedHashMap(d.archives)),
            heldArchives = Collections.unmodifiableMap(LinkedHashMap(held)))
        latch(owned.operation)
        for ((id, value) in owned.heldArchives) {
            if (value.failureObserved) observeFailureKey(id)
            if (value.continuationObserved) observeContinuationKey(id)
            value.observed.forEach { observeSettlementKey(id, it) }
            if (value.unattributedObserved) observeSettlementKey(id)
        }
        // Only a fully verified immutable archive can release its own old key.
        // Missing or corrupt other-key history never authorizes a new effect.
        val captured = Snapshot(raw, owned, journal(owned))
        for (id in heldKeys()) if (id != owned.operation?.request?.idempotencyKey && id in owned.archives) {
            try { releaseArchived(requireNotNull(archived(owned, id))) }
            catch (error: Exception) {
                // Invalid history cannot resolve its observation, but must not
                // prevent writable custody metadata from preserving that blocker.
                try { flushArchived(captured) } catch (storage: Exception) { if (storage !== error) error.addSuppressed(storage) }
                throw error
            }
        }
        // Resolve only exact covered history, then durably flush every remaining
        // archived-key hold before returning a snapshot to a new action.
        return flushArchived(captured)
    }
    private suspend fun archived(d: MiningTaxClaimsDocument, id: String): MiningTaxClaimsArchive? {
        key(id); val text = d.archives[id] ?: return null
        val raw = copyTaxBounded(taxStoreJson.parseToJsonElement(text)).jsonObject
        val value = taxStoreJson.decodeFromJsonElement(MiningTaxClaimsArchive.serializer(), raw)
        require(legacyTaxOperation(raw) == taxStoreJson.encodeToJsonElement(MiningTaxClaimsArchive.serializer(), value))
        require(value.version == 1 && value.identity == identity && value.revision in 1..d.revision && value.operation.request.idempotencyKey == id)
        value.previousKey?.let { key(it); require(it != id && it in d.archives) }
        val op = operation(value.operation); require(op.settlement?.status == "settled" || failedComplete(op) || continuedComplete(op) || op.absenceConfirmed)
        return value.copy(operation = op)
    }
    private fun releaseArchived(value: MiningTaxClaimsArchive) = synchronized(shared) {
        val op = value.operation; val id = op.request.idempotencyKey
        val continued = op.continuation != null
        // An absence archive has no preparation: any later hold on its key stays held (contradictory evidence), never throws.
        val covered = shared.holds[id]?.all { it != null && if (continued) it == 0 else op.preparation?.transactions?.indices?.contains(it) == true } != false
        val failureCovered = op.failure != null || !op.failureObserved && id !in shared.failureKeys
        val continuationCovered = if (continued) continuedComplete(op) else !op.continuationObserved && id !in shared.continuationKeys
        if (covered && failureCovered && continuationCovered) release(id)
    }
    /** Observations after archival are mutable custody metadata, not edits to an
     * immutable paid/failed receipt. Storage failure keeps the synchronous hold
     * and refuses the read/action until a later CAS flush can persist it. */
    private fun flushArchived(s: Snapshot): Snapshot = synchronized(shared) {
        val held = linkedMapOf<String, MiningTaxClaimsArchiveHold>()
        for (id in s.document.archives.keys) {
            val values = shared.holds[id] ?: emptySet()
            val failed = id in shared.failureKeys
            val continued = id in shared.continuationKeys
            if (values.isNotEmpty() || failed || continued) held[id] = MiningTaxClaimsArchiveHold(ownTax(values.filterNotNull().sorted()), null in values, failed, continued)
        }
        if (held == s.document.heldArchives) s.copy(journal = journal(s.document))
        else save(s, s.document.copy(heldArchives = Collections.unmodifiableMap(held)))
    }
    private suspend fun original(s: Snapshot, id: String): Original {
        key(id); s.document.operation?.takeIf { it.request.idempotencyKey == id }?.let { return Original(it, false) }
        return Original(requireNotNull(archived(s.document, id)) { "No saved tax request" }.operation, true)
    }
    private fun expected(s: Snapshot, expected: MiningTaxClaimsJournal) { check(s.journal == expected) { "Read the latest saved tax request" } }
    private fun save(s: Snapshot, next: MiningTaxClaimsDocument, guard: () -> Unit = {}): Snapshot = synchronized(shared) {
        check(s.document.revision < taxRevisionMax && secret.read() == s.raw) { "Saved tax request changed during verification" }
        guard()
        val d = next.copy(revision = s.document.revision + 1)
        val text = taxStoreJson.encodeToString(MiningTaxClaimsDocument.serializer(), d); require(text.length <= taxDocumentChars)
        secret.write(text)
        Snapshot(text, d, journal(d))
    }
    suspend fun read(): MiningTaxClaimsJournal = shared.updates.withLock { snapshot().journal }
    /** Capture only verified historical setup context, then recheck the live hold
     * map synchronously at every wallet/MFA/HTTP effect boundary. This is a refusal
     * guard, not signing authority; it never releases a hold or permits a replay. */
    suspend fun effectGuard(expected: MiningTaxClaimsJournal, ordinal: Int): () -> Unit = shared.updates.withLock {
        checkOrdinal(ordinal); val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation)
        require(ordinal in requireNotNull(op.preparation).transactions.indices); mayStart(op, ordinal)
        val guard: () -> Unit = { mayStart(op, ordinal) }
        guard
    }
    suspend fun archived(id: String): MiningTaxClaimsArchive? = shared.updates.withLock {
        val s = snapshot()
        try {
            val value = archived(s.document, id); if (value != null) releaseArchived(value); value
        } finally { flushArchived(s) }
    }
    suspend fun begin(expected: MiningTaxClaimsJournal, request: MiningTaxClaimsPrepareRequest, totalSpots: Int): MiningTaxClaimsJournal {
        val owned = request.copy(caps = request.caps.copy()); owned.validate(totalSpots)
        return shared.updates.withLock {
            val s = snapshot(); expected(s, expected); check(s.document.operation == null && owned.idempotencyKey !in s.document.archives); noHeld()
            require(s.document.archives.size < taxArchives && (s.raw?.length ?: 0) + 2 * taxArchiveChars <= taxDocumentChars) { "Tax history storage is full" }
            val op = MiningTaxClaimsOperation(owned, savedTrust, rules.daySec, false, null, ownTax(emptyList()), ownTax(emptyList()), false, null, null)
            save(s, s.document.copy(operation = op), ::noHeld).journal
        }
    }
    suspend fun prepareAttempt(expected: MiningTaxClaimsJournal): MiningTaxClaimsJournal = shared.updates.withLock {
        val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation)
        check(!op.prepareAttempted && op.preparation == null); noHeld()
        save(s, s.document.copy(operation = op.copy(prepareAttempted = true)), ::noHeld).journal
    }
    suspend fun acceptPreparation(id: String, preparation: MiningTaxClaimsPreparation): MiningTaxClaimsJournal {
        val p = ownTaxPreparation(preparation)
        return withContext(NonCancellable) { shared.updates.withLock {
            val s = snapshot(); val found = original(s, id); val op = found.operation
            require(op.prepareAttempted && p.wallet == identity.wallet && op.request == MiningTaxClaimsPrepareRequest(p.idempotencyKey, p.round, p.spot, p.caps))
            MiningTaxClaimsCrypto.prepare(p, pins, rules)
            if (op.preparation != null) { check(op.preparation == p); return@withLock s.journal }
            check(!found.archived); save(s, s.document.copy(operation = op.copy(preparation = p))).journal
        } }
    }
    suspend fun signingAttempt(expected: MiningTaxClaimsJournal, ordinal: Int): MiningTaxClaimsJournal = shared.updates.withLock {
        checkOrdinal(ordinal); val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation)
        require(ordinal in requireNotNull(op.preparation).transactions.indices); check(op.transactions.none { it.ordinal == ordinal }); mayStart(op, ordinal)
        val next = op.copy(transactions = ownTax((op.transactions + MiningTaxClaimsCustody(ordinal, true, null, false)).sortedBy { it.ordinal }))
        save(s, s.document.copy(operation = next)) { mayStart(op, ordinal) }.journal
    }
    private suspend fun signed(s: Snapshot, id: String, ordinal: Int, wire: String): Snapshot {
        checkOrdinal(ordinal); val found = original(s, id); val op = found.operation; val custody = requireNotNull(op.transactions.find { it.ordinal == ordinal })
        check(custody.signingStarted)
        val saved = MiningTaxClaimsSavedWire.from(MiningTaxClaimsCrypto.verifySigned(requireNotNull(op.preparation), wire, rules, ordinal))
        if (custody.signed != null) { check(custody.signed == saved); return s }
        check(!found.archived)
        return save(s, s.document.copy(operation = op.copy(transactions = ownTax(op.transactions.map { if (it.ordinal == ordinal) it.copy(signed = saved) else it }))))
    }
    /** A valid late wallet result is retained even when cancellation/session/positive
     * holds would prohibit starting a new effect. The prior signing marker is required. */
    suspend fun acceptSigned(id: String, ordinal: Int, wire: String): MiningTaxClaimsJournal = withContext(NonCancellable) {
        shared.updates.withLock { signed(snapshot(), id, ordinal, wire).journal }
    }
    suspend fun submitAttempt(expected: MiningTaxClaimsJournal, ordinal: Int): MiningTaxClaimsJournal = shared.updates.withLock {
        checkOrdinal(ordinal); val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation)
        val tx = requireNotNull(op.transactions.find { it.ordinal == ordinal }); check(tx.signed != null && !tx.submitAttempted); mayStart(op, ordinal)
        val next = op.copy(transactions = ownTax(op.transactions.map { if (it.ordinal == ordinal) it.copy(submitAttempted = true) else it }))
        save(s, s.document.copy(operation = next)) { mayStart(op, ordinal) }.journal
    }
    private suspend fun observed(id: String, ordinal: Int?): Snapshot {
        observeSettlementKey(id, ordinal)
        val s = snapshot(); val found = original(s, id); val op = found.operation
        if (found.archived) return s
        if (ordinal == null && op.unattributedObserved || ordinal in op.observed) return s
        val next = if (ordinal == null) op.copy(unattributedObserved = true) else op.copy(observed = ownTax((op.observed + ordinal).sorted()))
        return save(s, s.document.copy(operation = next))
    }
    suspend fun observeSettlement(id: String, ordinal: Int? = null): MiningTaxClaimsJournal {
        observeSettlementKey(id, ordinal)
        return withContext(NonCancellable) { shared.updates.withLock { observed(id, ordinal).journal } }
    }
    private suspend fun retainWires(initial: Snapshot, id: String, input: JsonObject): Snapshot {
        var s = initial; val rows = input.getValue("wires").jsonArray.toList(); require(rows.size <= 2)
        var failure: Exception? = null
        for (row in rows) try {
            val wire = MiningTaxClaimsSignedWire.from(row.jsonObject); val op = original(s, id).operation; val p = requireNotNull(op.preparation)
            require(wire.wallet == identity.wallet && wire.idempotencyKey == id && wire.claimId == p.claimId)
            val encoded = Base64.getEncoder().encodeToString(taxHex(wire.signedTransactionHex))
            val checked = MiningTaxClaimsCrypto.verifySigned(p, encoded, rules, wire.ordinal.toInt())
            require(checked.signature == wire.signature && checked.messageSha256 == wire.messageSha256 && checked.wireSha256 == wire.wireSha256)
            if (op.transactions.any { it.ordinal == wire.ordinal.toInt() && it.signingStarted }) s = signed(s, id, wire.ordinal.toInt(), encoded)
        } catch (error: Exception) {
            observeSettlementKey(id); if (failure == null) failure = error
        }
        failure?.let { error ->
            try { observed(id, null) } catch (storage: Exception) { if (storage !== error) error.addSuppressed(storage) }
            throw error
        }
        return s
    }
    private suspend fun failedObserved(id: String): Snapshot {
        observeFailureKey(id); val s = snapshot(); val found = original(s, id)
        if (found.archived || found.operation.failureObserved) return s
        return save(s, s.document.copy(operation = found.operation.copy(failureObserved = true)))
    }
    suspend fun observeFailure(id: String): MiningTaxClaimsJournal {
        observeFailureKey(id)
        return withContext(NonCancellable) { shared.updates.withLock { failedObserved(id).journal } }
    }
    private fun continuedComplete(op: MiningTaxClaimsOperation): Boolean = op.continuation?.attempted == true && op.continuation.envelope?.continuation != null &&
        op.setup != null && op.preparation?.transactions?.size == 2 && op.settlement == null && op.failure == null && !op.failureObserved &&
        !op.unattributedObserved && op.observed.all { it == 0 } && op.transactions.none { it.ordinal == 1 }
    private fun continuationReady(op: MiningTaxClaimsOperation, bound: Boolean = false) = synchronized(shared) {
        val id = op.request.idempotencyKey
        check(op.setup != null && op.preparation?.transactions?.size == 2 && op.settlement == null && op.failure == null && !op.failureObserved && !op.unattributedObserved)
        check(op.observed.all { it == 0 } && op.transactions.none { it.ordinal == 1 }) { "Original claim approval remains unresolved" }
        check(shared.holds.keys.none { it != id } && shared.failureKeys.isEmpty() && shared.holds[id]?.all { it == 0 } != false) { "Unknown tax evidence holds continuation" }
        check(bound || !op.continuationObserved && shared.continuationKeys.isEmpty()) { "Recover the existing tax link" }
    }
    suspend fun continuationGuard(expected: MiningTaxClaimsJournal): () -> Unit = shared.updates.withLock {
        val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation)
        continuationReady(op); check(op.continuation?.attempted == true && op.continuation.envelope == null)
        val guard: () -> Unit = { continuationReady(op) }; guard
    }
    suspend fun beginContinuation(expected: MiningTaxClaimsJournal, request: MiningTaxClaimsContinuationRequest): MiningTaxClaimsJournal {
        val owned = request.copy(caps = request.caps.copy()).also { it.validate() }
        return shared.updates.withLock {
            val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation); continuationReady(op)
            check(op.continuation == null && owned.idempotencyKey != op.request.idempotencyKey && owned.idempotencyKey !in s.document.archives)
            require(s.document.archives.size < taxArchives && (s.raw?.length ?: 0) + 2 * taxArchiveChars <= taxDocumentChars)
            save(s, s.document.copy(operation = op.copy(continuation = MiningTaxClaimsContinuationIntent(owned, false, null)))) { continuationReady(op) }.journal
        }
    }
    suspend fun continuationAttempt(expected: MiningTaxClaimsJournal): MiningTaxClaimsJournal = shared.updates.withLock {
        val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation); val c = requireNotNull(op.continuation)
        continuationReady(op); check(!c.attempted && c.envelope == null)
        save(s, s.document.copy(operation = op.copy(continuation = c.copy(attempted = true)))) { continuationReady(op) }.journal
    }
    /** Explicit replay uses the same unsigned child request. The caller must first
     * GET parent/failures/link under requests and supply the unchanged revision. */
    suspend fun resumeContinuationAttempt(expected: MiningTaxClaimsJournal): MiningTaxClaimsJournal = shared.updates.withLock {
        val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation); val c = requireNotNull(op.continuation)
        continuationReady(op); check(c.envelope == null)
        save(s, s.document.copy(operation = op.copy(continuation = c.copy(attempted = true)))) { continuationReady(op) }.journal
    }
    private suspend fun continuationObserved(id: String): Snapshot {
        observeContinuationKey(id); val s = snapshot(); val found = original(s, id)
        if (found.archived || found.operation.continuationObserved) return s
        return save(s, s.document.copy(operation = found.operation.copy(continuationObserved = true)))
    }
    suspend fun observeContinuation(id: String): MiningTaxClaimsJournal {
        observeContinuationKey(id)
        return withContext(NonCancellable) { shared.updates.withLock { continuationObserved(id).journal } }
    }
    suspend fun acceptContinuation(id: String, envelope: MiningTaxClaimsContinuationEnvelope): MiningTaxClaimsJournal {
        observeContinuationKey(id); val captured = runCatching { ownTaxContinuation(envelope) }
        return withContext(NonCancellable) { shared.updates.withLock {
            val s = continuationObserved(id); val found = original(s, id); val op = found.operation; val c = requireNotNull(op.continuation)
            require(c.attempted)
            val bound = MiningTaxClaimsContinuationCrypto.bind(local(op), requireNotNull(op.setup), c.request, captured.getOrThrow(), pins, rules).envelope
            if (c.envelope != null) { require(c.envelope.continuation == bound.continuation); return@withLock s.journal }
            check(!found.archived)
            save(s, s.document.copy(operation = op.copy(continuation = c.copy(envelope = bound)))).journal
        } }
    }
    /** Atomic predecessor history plus distinct child activation. No signing or
     * submission marker is inherited; the child needs its own fresh review. */
    suspend fun activateContinuation(expected: MiningTaxClaimsJournal, fresh: MiningTaxClaimsContinuationEnvelope,
        parent: MiningTaxClaimsRecoveryEnvelope, failures: MiningTaxClaimsFailureEnvelope, guard: () -> Unit = {}): MiningTaxClaimsJournal {
        val link = ownTaxContinuation(fresh); val original = ownTaxRecovery(parent)
        require(failures.failures.isEmpty()); val failedRecovery = ownTaxRecovery(failures.recovery)
        return shared.updates.withLock {
            val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation); continuationReady(op, true); check(continuedComplete(op))
            val intent = requireNotNull(op.continuation)
            val bound = MiningTaxClaimsContinuationCrypto.bind(local(op), requireNotNull(op.setup), intent.request, link, pins, rules).envelope
            require(intent.envelope?.continuation == bound.continuation)
            for (r in listOf(original, failedRecovery)) {
                require(r.wires.size == 1 && r.wires.single().ordinal == 0L && sameTaxEvidence(op.setup, r))
                require(MiningTaxClaimsCrypto.bindSettlement(local(op), r, pins, rules).phase == "setup")
            }
            val c = requireNotNull(bound.continuation).childPreparation; val id = op.request.idempotencyKey
            require(c.idempotencyKey !in s.document.archives && id !in s.document.archives && s.document.archives.size < taxArchives)
            val archive = MiningTaxClaimsArchive(1, identity, s.document.revision, s.document.lastArchivedKey, op)
            val text = taxStoreJson.encodeToString(MiningTaxClaimsArchive.serializer(), archive); require(text.length <= taxArchiveChars)
            val child = MiningTaxClaimsOperation(MiningTaxClaimsPrepareRequest(c.idempotencyKey, c.round, c.spot, c.caps), savedTrust, rules.daySec,
                true, c, ownTax(emptyList()), ownTax(emptyList()), false, null, null)
            val saved = save(s, s.document.copy(operation = child, lastArchivedKey = id, archives = s.document.archives + (id to text))) { guard(); continuationReady(op, true) }
            releaseArchived(archive); flushArchived(saved).journal
        }
    }
    /** Positive packet failure is held before parsing/storage. Wires with existing
     * local consent drain before adjacent malformed owner assertions can refuse. */
    suspend fun acceptFailure(id: String, raw: JsonElement): MiningTaxClaimsJournal {
        observeFailureKey(id)
        val rows = (raw as? JsonObject)?.get("failures") as? JsonArray
        val ordinals = if (rows == null || rows.size !in 1..2) listOf(null) else rows.map { row ->
            ((row as? JsonObject)?.get("ordinal") as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull?.takeIf { it in 0..1 }
        }
        ordinals.forEach { observeSettlementKey(id, it) }
        val captured = runCatching { copyTaxBounded(raw) }
        return try { withContext(NonCancellable) { shared.updates.withLock {
            var s = failedObserved(id); for (ordinal in ordinals) s = observed(id, ordinal)
            val input = captured.getOrThrow().jsonObject
            s = retainWires(s, id, input.getValue("recovery").jsonObject)
            val found = original(s, id); val op = found.operation
            val bound = MiningTaxClaimsFailureCrypto.bind(local(op), MiningTaxClaimsFailureEnvelope.from(input), pins, rules).envelope
            check(op.settlement == null)
            op.setup?.let { require(sameTaxEvidence(it, bound.recovery)) { "Saved setup outcome changed" } }
            op.failure?.let { require(extendsTaxFailure(it, bound)) { "Immutable tax failure changed" } }
            val setup = bound.recovery.takeIf { it.settlement?.receipt?.phase == "setup" }
            if (!found.archived && setup != null && 0 !in op.observed) s = observed(id, 0)
            val next = original(s, id).operation.copy(failure = bound, setup = op.setup ?: setup)
            if (op.failure != null && extendsTaxFailure(bound, op.failure) && op.setup == next.setup) return@withLock s.journal
            check(!found.archived)
            // This validates all saved outcomes together, including local custody and non-overlap.
            save(s, s.document.copy(operation = operation(next))).journal
        } } } catch (error: Exception) {
            // A failed binder can contradict otherwise valid setup0. Its ordinal
            // alone must not let an already captured claim1 guard proceed.
            observeSettlementKey(id)
            try { withContext(NonCancellable) { shared.updates.withLock { observed(id, null) } } }
            catch (storage: Exception) { if (storage !== error) error.addSuppressed(storage) }
            throw error
        }
    }
    private fun failedComplete(op: MiningTaxClaimsOperation): Boolean {
        val p = op.preparation ?: return false; val f = op.failure ?: return false
        if (op.settlement != null || op.unattributedObserved || f.failures.isEmpty() || op.continuation != null || op.continuationObserved) return false
        val failed = f.failures.map { it.ordinal.toInt() }.toSet()
        val paid = op.setup?.settlement?.receipt?.transactions?.indices?.toSet() ?: emptySet()
        return failed.intersect(paid).isEmpty() && p.transactions.indices.all { it in failed || it in paid } && op.observed.all { it in p.transactions.indices }
    }
    private fun failureArchiveGuard(op: MiningTaxClaimsOperation) = synchronized(shared) {
        check(failedComplete(op)) { "Every original tax ordinal requires a bound outcome" }
        check(op.request.idempotencyKey !in shared.continuationKeys) { "Contradictory tax continuation remains held" }
        check(shared.holds[op.request.idempotencyKey]?.all { it != null && it in requireNotNull(op.preparation).transactions.indices } != false) { "Unattributed tax evidence remains held" }
    }
    /** The repository supplies a fresh authenticated original-key GET while owning
     * requests. A newly discovered outcome or wire changes the pre-GET revision and
     * requires another explicit archive action. This method supplies no HTTP authority. */
    suspend fun archiveFailed(expected: MiningTaxClaimsJournal, fresh: MiningTaxClaimsFailureEnvelope,
        guard: () -> Unit = {}): MiningTaxClaimsJournal {
        val owned = ownTaxFailure(fresh)
        return shared.updates.withLock {
            val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation)
            failureArchiveGuard(op)
            val bound = MiningTaxClaimsFailureCrypto.bind(local(op), owned, pins, rules).envelope
            val previous = requireNotNull(op.failure)
            require(extendsTaxFailure(previous, bound) && extendsTaxFailure(bound, previous)) { "Fresh tax failure differs from saved outcomes" }
            archive(s, op) { guard(); failureArchiveGuard(op) }
        }
    }
    /** Called only for an attributed positive owner reply. Latch before fallible
     * storage/parsing. Retain valid started wires before adjacent receipt failure. */
    suspend fun acceptRecovery(id: String, ordinal: Int?, raw: JsonElement): MiningTaxClaimsJournal {
        observeSettlementKey(id, ordinal)
        val captured = runCatching { copyTaxBounded(raw) }
        return withContext(NonCancellable) { shared.updates.withLock {
            var s = observed(id, ordinal); val input = captured.getOrThrow().jsonObject
            s = retainWires(s, id, input)
            val recovery = MiningTaxClaimsRecoveryEnvelope.from(input)
            val found = original(s, id); val op = found.operation
            val bound = MiningTaxClaimsCrypto.bindSettlement(local(op), recovery, pins, rules)
            val receiptOrdinal = requireNotNull(recovery.settlement).ordinal.toInt()
            // Even an unattributed positive gets its verified ordinal persisted before receipt publication.
            if (!found.archived && receiptOrdinal !in op.observed) s = observed(id, receiptOrdinal)
            val current = original(s, id); val old = if (bound.phase == "setup") current.operation.setup else current.operation.settlement
            if (old != null) {
                require(sameTaxEvidence(old, recovery)) { "Immutable tax owner receipt changed" }
                return@withLock s.journal
            }
            check(!current.archived)
            val next = if (bound.phase == "setup") current.operation.copy(setup = bound.recovery) else current.operation.copy(settlement = bound.recovery)
            save(s, s.document.copy(operation = operation(next))).journal
        } }
    }
    suspend fun archive(expected: MiningTaxClaimsJournal): MiningTaxClaimsJournal = shared.updates.withLock {
        val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation)
        check(op.settlement?.status == "settled") { "Only a bound full payment can be archived" }
        fun noFailure() = synchronized(shared) { check(!op.failureObserved && op.request.idempotencyKey !in shared.failureKeys && op.continuation == null && !op.continuationObserved && op.request.idempotencyKey !in shared.continuationKeys) { "Contradictory tax evidence remains held" } }
        noFailure(); archive(s, op, ::noFailure)
    }
    /** Owner rule 2026-10-06 (no saved request blocks play forever): retires a request that never recovered a
     * preparation, signed nothing and holds no evidence, only with the repository's fresh by-key prepare read (made
     * while owning requests) answering `unknown` for exactly its key. The raw CAS rejects a preparation that arrived. */
    suspend fun archiveAbsent(expected: MiningTaxClaimsJournal, fresh: MiningTaxClaimsPreparationEnvelope, guard: () -> Unit = {}): MiningTaxClaimsJournal {
        fresh.validate()
        return shared.updates.withLock {
            val s = snapshot(); expected(s, expected); val op = requireNotNull(s.document.operation); val id = op.request.idempotencyKey
            check(fresh.wallet == identity.wallet && fresh.idempotencyKey == id && fresh.status == "unknown" && fresh.preparation == null) { "The server still has this tax request" }
            fun nothingHeld() = check(op.preparation == null && op.transactions.isEmpty() && op.observed.isEmpty() && !op.unattributedObserved &&
                op.setup == null && op.settlement == null && op.failure == null && !op.failureObserved && op.continuation == null &&
                !op.continuationObserved && !settlementHeld(id)) { "Only a tax request without a preparation or held evidence can close" }
            nothingHeld(); archive(s, op.copy(absenceConfirmed = true)) { guard(); nothingHeld() }
        }
    }
    private fun archive(s: Snapshot, op: MiningTaxClaimsOperation, guard: () -> Unit = {}): MiningTaxClaimsJournal {
        val id = op.request.idempotencyKey; check(id !in s.document.archives && s.document.archives.size < taxArchives)
        val archive = MiningTaxClaimsArchive(1, identity, s.document.revision, s.document.lastArchivedKey, op)
        val text = taxStoreJson.encodeToString(MiningTaxClaimsArchive.serializer(), archive); require(text.length <= taxArchiveChars)
        val saved = save(s, s.document.copy(operation = null, lastArchivedKey = id, archives = s.document.archives + (id to text)), guard)
        releaseArchived(archive); return flushArchived(saved).journal
    }
}

private fun checkOrdinal(ordinal: Int) { require(ordinal in 0..1) }
private fun key(v: String) {
    require(v.length == 36 && (v.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) ||
        v == "00000000-0000-0000-0000-000000000000" || v == "ffffffff-ffff-ffff-ffff-ffffffffffff"))
}
private fun <T> ownTax(values: List<T>): List<T> = Collections.unmodifiableList(ArrayList(values))
private fun ownTaxPreparation(p: MiningTaxClaimsPreparation): MiningTaxClaimsPreparation {
    require(p.transactions.size in 1..2 && p.setup.accrualDays.size <= 10); p.transactions.forEach { require(it.newAccounts.size <= 10) }
    return p.copy(setup = p.setup.copy(accrualDays = ownTax(p.setup.accrualDays)), transactions = ownTax(p.transactions.map { it.copy(newAccounts = ownTax(it.newAccounts)) })).also { it.validate() }
}
private fun ownTaxRecovery(r: MiningTaxClaimsRecoveryEnvelope): MiningTaxClaimsRecoveryEnvelope {
    require(r.wires.size <= 2); r.settlement?.let { require(it.receipt.transactions.size in 1..2) }
    return r.copy(preparation = r.preparation?.let(::ownTaxPreparation), wires = ownTax(r.wires),
        settlement = r.settlement?.let { it.copy(receipt = it.receipt.copy(transactions = ownTax(it.receipt.transactions))) }).also { it.validate() }
}
private fun sameTaxEvidence(a: MiningTaxClaimsRecoveryEnvelope, b: MiningTaxClaimsRecoveryEnvelope): Boolean {
    // serverNow is a response observation, not the immutable owner receipt. An
    // extra signed custody row may arrive after setup and never changes its receipt.
    return a.copy(serverNow = b.serverNow, wires = b.wires) == b && a.wires.all { old -> b.wires.any { it == old } }
}
private fun taxHex(v: String): ByteArray {
    require(v.length in 132..2464 && v.matches(Regex("(?:[0-9a-f]{2})+")))
    return ByteArray(v.length / 2) { v.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
private fun copyTaxBounded(raw: JsonElement): JsonElement {
    var nodes = 0
    fun copy(v: JsonElement, depth: Int): JsonElement {
        require(++nodes <= 2048 && depth <= 16)
        return when (v) {
            is JsonObject -> { require(v.size <= 40); JsonObject(v.entries.associate { (key, value) -> require(key.length <= 64); key to copy(value, depth + 1) }) }
            is JsonArray -> { require(v.size <= 10); JsonArray(v.map { copy(it, depth + 1) }) }
            is JsonPrimitive -> v.also { require(v.content.length <= 2464) }
        }
    }
    return copy(raw, 0)
}

/** Only additive observation/continuation fields may be absent in legacy data. */
private fun legacyTaxOperation(raw: JsonObject): JsonObject {
    val fields = raw.toMutableMap()
    if ("archives" in fields && "heldArchives" !in fields) fields["heldArchives"] = JsonObject(emptyMap())
    (fields["heldArchives"] as? JsonObject)?.let { rows -> fields["heldArchives"] = JsonObject(rows.mapValues { (_, row) ->
        val value = row.jsonObject; if ("continuationObserved" in value) value else JsonObject(value + ("continuationObserved" to JsonPrimitive(false)))
    }) }
    (raw["operation"] as? JsonObject)?.let { op ->
        val operation = op.toMutableMap()
        if ("failure" !in operation) operation["failure"] = JsonNull
        if ("failureObserved" !in operation) operation["failureObserved"] = JsonPrimitive(false)
        if ("continuation" !in operation) operation["continuation"] = JsonNull
        if ("continuationObserved" !in operation) operation["continuationObserved"] = JsonPrimitive(false)
        if ("absenceConfirmed" !in operation) operation["absenceConfirmed"] = JsonPrimitive(false)
        fields["operation"] = JsonObject(operation)
    }
    return JsonObject(fields)
}
private fun ownTaxContinuation(value: MiningTaxClaimsContinuationEnvelope): MiningTaxClaimsContinuationEnvelope {
    value.continuation?.let { ownTaxPreparation(it.parentPreparation); ownTaxPreparation(it.childPreparation); require(it.parentSetup.receipt.transactions.size in 1..2) }
    value.validate()
    return MiningTaxClaimsContinuationEnvelope.from(taxStoreJson.encodeToJsonElement(MiningTaxClaimsContinuationEnvelope.serializer(), value).jsonObject)
}
private fun ownTaxFailure(f: MiningTaxClaimsFailureEnvelope): MiningTaxClaimsFailureEnvelope {
    require(f.failures.size in 1..2 && f.recovery.wires.size <= 2)
    val recovery = ownTaxRecovery(f.recovery)
    return MiningTaxClaimsFailureEnvelope.from(taxStoreJson.encodeToJsonElement(MiningTaxClaimsFailureEnvelope.serializer(), f.copy(recovery = recovery)).jsonObject)
}
private fun extendsTaxFailure(old: MiningTaxClaimsFailureEnvelope, next: MiningTaxClaimsFailureEnvelope): Boolean {
    val a = old.recovery; val b = next.recovery
    return a.wallet == b.wallet && a.idempotencyKey == b.idempotencyKey && a.claimId == b.claimId && a.preparation == b.preparation &&
        a.wires.all { it in b.wires } && old.failures.all { it in next.failures } &&
        (a.settlement == null || sameTaxEvidence(a, b))
}
