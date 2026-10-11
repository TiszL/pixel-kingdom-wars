package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import java.math.BigInteger
import java.util.UUID
import java.time.Instant
import java.time.ZoneOffset
import java.time.LocalDate

/** [pollMs] null = no cadence source (the status-derived fallback below): the client reads on open and on CHECK AGAIN only. */
data class SkrFaucetBounds(val pollMs: Long?, val grantSkr: String, val grantReadPageSize: Int? = null) {
    init { require((pollMs == null || pollMs > 0) && grantSkr.matches(Regex("[1-9][0-9]*"))); require(grantReadPageSize == null || grantReadPageSize > 0) }
    companion object { fun from(catalogue: JsonObject?): SkrFaucetBounds? = runCatching {
        val constants = requireNotNull(catalogue?.get("constants") as? JsonObject)
        val policy = constants.getValue("SKR_FAUCET").jsonObject.getValue("devnet").jsonObject
        val poll = requireNotNull((policy["pollMs"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull)
        val human = requireNotNull((policy["grantSkr"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull)
        val readPageSize = policy["grantReadPageSize"]?.let {
            requireNotNull((it as? JsonPrimitive)?.takeUnless { value -> value.isString }?.intOrNull)
        }
        SkrFaucetBounds(poll, human.toString(), readPageSize)
    }.getOrNull()
        /** Night 2026-10-06, only while the bundled pack has no SKR_FAUCET block: the grant the server's own status names,
         *  accepted only when that status names this build's pinned mint and decimals and its grantRaw is exactly grantSkr
         *  at those decimals. The status carries no poll cadence and no grant-read page size, so neither is set: no
         *  polling, and lost-claim discovery stays off until the catalogue supplies them (no Kotlin default). */
        fun fromStatus(status: SkrFaucetStatus, pin: SkrIdentity): SkrFaucetBounds? = runCatching {
            require(status.mint == pin.mint && status.decimals == pin.decimals)
            val raw = status.grantSkr.toBigInteger().multiply(BigInteger.TEN.pow(pin.decimals))
            require(raw.bitLength() <= 64 && status.grantRaw == raw.toString())
            SkrFaucetBounds(null, status.grantSkr)
        }.getOrNull()
    }
}
fun skrFaucetEntryDiscovered(configured: Boolean, contains: () -> Boolean): Boolean = configured || runCatching(contains).getOrDefault(true)

data class SkrFaucetState(val status: SkrFaucetStatus? = null, val grant: SkrFaucetGrant? = null,
    val busy: Boolean = false, val available: Boolean = false, val uncertain: Boolean = false, val canClaim: Boolean = false,
    val error: String? = null, val networkFeeLamports: String? = null, val accountRentLamports: String? = null,
    val arrival: SkrFaucetGrant? = null, val discoveryNextCursor: String? = null)

/** Sign-only wallet adapter, with durable evidence callback before its post-wallet guard. */
typealias SkrFaucetSigner = suspend (PreparedSkrFaucetClaim, () -> Unit, suspend (SignedSkrFaucetClaim) -> Unit) -> Unit

class SkrFaucetRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val journal: SkrFaucetJournal, private val identity: () -> SkrIdentity?,
    private val bounds: () -> SkrFaucetBounds?, private val selectedBase: () -> String?,
    private val signer: SkrFaucetSigner, private val refreshWallet: suspend () -> Unit,
    private val actionGuard: () -> Unit = {}, private val walletAvailable: suspend () -> Unit = {},
    private val actionEpoch: () -> Any? = { null }) {
    private val mutable = MutableStateFlow(SkrFaucetState())
    val state = mutable.asStateFlow()
    private val admission = journal.admission
    private var capturedEpoch: Any? = null
    /** Only uninterrupted, validated head-to-tail pages can prove no match.
     * This proof is intentionally ephemeral: a new repository restarts at the head. */
    private data class DiscoveryScan(val saved: SkrFaucetRecord, val pin: SkrIdentity,
        val policy: SkrFaucetBounds, val base: String?, val epoch: Any?, val serverDay: LocalDate,
        val pages: List<SkrFaucetGrantPage> = emptyList())
    private var discovery: DiscoveryScan? = null
    private var releasedDuringAction = false
    private var releaseNotice: String? = null
    private fun resetDiscovery() {
        discovery = null
        mutable.update { it.copy(discoveryNextCursor = null) }
    }
    private fun current() = holder.requireCurrent(session)
    private fun contextGuard(base: String?, pin: SkrIdentity, policy: SkrFaucetBounds) {
        current()
        require(identity() == pin && bounds() == policy && selectedBase() == base && actionEpoch() == capturedEpoch) { "Faucet selection changed. Check again." }
    }
    private fun guard(base: String?, pin: SkrIdentity, policy: SkrFaucetBounds) { contextGuard(base, pin, policy); actionGuard() }
    private suspend fun action(block: suspend (SkrIdentity, SkrFaucetBounds) -> Unit) {
        current(); if (!admission.tryLock()) return
        capturedEpoch = actionEpoch()
        releasedDuringAction = false; releaseNotice = null
        mutable.update { it.copy(busy = true, error = null, canClaim = false) }
        try {
            val saved = journal.read(); current()
            if (discovery?.saved != saved) resetDiscovery()
            val pin = identity(); val policy = bounds()
            mutable.update { it.copy(available = saved != null || (pin != null && policy != null && it.available), uncertain = saved != null && saved.grant == null,
                grant = if (saved != null) saved.grant else it.grant) }
            if (pin == null || policy == null) { resetDiscovery(); return }
            block(pin, policy)
        } catch (error: CancellationException) { resetDiscovery(); throw error }
        catch (error: Exception) {
            resetDiscovery()
            current()
            val absent = error is ApiException && error.status == 404 && error.code == null
            val retained = runCatching { journal.read() != null }.getOrDefault(true)
            val supportedRefusal = error is ApiException && error.code != null && identity() != null && bounds() != null
            mutable.update { it.copy(available = retained || (!absent && (it.available || supportedRefusal)),
                error = releaseNotice ?: if (absent) null else errorText(error), canClaim = false) }
        } finally {
            admission.unlock(); if (holder.isCurrent(session)) mutable.update { it.copy(busy = false) }
        }
    }
    private fun amount(pin: SkrIdentity, policy: SkrFaucetBounds): String =
        policy.grantSkr.toBigInteger().multiply(BigInteger.TEN.pow(pin.decimals)).also {
            require(it.signum() > 0 && it.bitLength() <= 64)
        }.toString()
    private fun checkGrant(grant: SkrFaucetGrant, pin: SkrIdentity, policy: SkrFaucetBounds) {
        require(grant.mint == pin.mint && grant.decimals == pin.decimals && grant.amountRaw == amount(pin, policy)) { "Faucet token identity changed." }
    }
    private suspend fun readStatus(pin: SkrIdentity, policy: SkrFaucetBounds, base: String?): SkrFaucetStatus {
        val raw = api.get("/devnet-skr-faucet/status", base?.let { mapOf("baseId" to it) } ?: emptyMap()); contextGuard(base, pin, policy)
        val status = decode("status") { SkrFaucetStatus.from(raw) }
        require(status.grantSkr == policy.grantSkr)
        status.mint?.let { require(it == pin.mint) }
        status.decimals?.let { require(it == pin.decimals) }
        status.grantRaw?.let { require(it == amount(pin, policy)) }
        status.today?.let { checkGrant(it, pin, policy) }
        val saved = journal.read()
        mutable.update { it.copy(status = status, available = true, grant = if (saved != null) saved.grant else status.today,
            canClaim = status.enabled && status.eligible && status.reason.isValue("ok") && status.mint == pin.mint &&
                status.decimals == pin.decimals && status.grantRaw == amount(pin, policy) && saved == null && base != null) }
        val fresh = status.today
        if (saved?.grant != null && status.reason.known) {
            resetDiscovery()
            if (fresh?.id == saved.grant.id) observeGrant(saved, fresh, pin, policy, base)
            else {
                // Beacon552d2d4d: previous-day submitted evidence remains addressable by its owned grant ID.
                val response = api.get("/devnet-skr-faucet/grants/${saved.grant.id}")
                contextGuard(base, pin, policy)
                val owned = decode("grants/${saved.grant.id}") { SkrFaucetGrant.from(response.getValue("grant").jsonObject) }
                observeGrant(saved, owned, pin, policy, base)
            }
        } else if (saved != null && status.reason.known) {
            discoverLostClaim(saved, pin, policy, base, status.day)
        } else resetDiscovery()
        return status
    }
    private fun unsignedGrantless(saved: SkrFaucetRecord) = saved.grant == null && saved.attemptId == null &&
        saved.signedTransaction == null && !saved.preparePending
    private fun releaseUnsigned(saved: SkrFaucetRecord, pin: SkrIdentity, policy: SkrFaucetBounds, base: String?, notice: String) {
        contextGuard(base, pin, policy)
        check(unsignedGrantless(saved))
        // Existing journal CAS refuses a replacement made while HTTP was awaited.
        journal.clear(saved)
        resetDiscovery(); releasedDuringAction = true; releaseNotice = notice
        mutable.update { it.copy(grant = null, uncertain = false, canClaim = false, arrival = null,
            networkFeeLamports = null, accountRentLamports = null, error = notice) }
    }
    private suspend fun discoverLostClaim(saved: SkrFaucetRecord, pin: SkrIdentity, policy: SkrFaucetBounds,
        base: String?, serverDay: String) {
        // A refresh starts a new complete proof; it never trusts a remembered tail alone.
        resetDiscovery()
        // Dead-end audit 2026-10-06: a version-1 (no claim day) intent also scans; see the zero-pending rule below.
        // Without the catalogue's grantReadPageSize no completeness proof exists, so discovery stays off (no Kotlin default).
        if (!unsignedGrantless(saved) || policy.grantReadPageSize == null) return
        readDiscoveryPage(DiscoveryScan(saved, pin, policy, base, capturedEpoch, LocalDate.parse(serverDay)), null)
    }
    private suspend fun readDiscoveryPage(scan: DiscoveryScan, after: String?) {
        require(if (scan.pages.isEmpty()) after == null else after != null && scan.pages.last().nextCursor == after)
        val cap = requireNotNull(scan.policy.grantReadPageSize)
        val raw = api.get("/devnet-skr-faucet/grants", after?.let { mapOf("after" to it) } ?: emptyMap())
        contextGuard(scan.base, scan.pin, scan.policy)
        require(scan.epoch == capturedEpoch && journal.read() == scan.saved) { "Faucet recovery context changed." }
        val page = decode("grants") { SkrFaucetGrantPage.from(raw, cap) }
        // Every page participates in the absence proof, including rows from other days.
        require(page.items.all { it.status.isValue("requested") && it.attempt?.phase?.known != false })
        page.items.forEach { checkGrant(it, scan.pin, scan.policy) }
        require(page.nextCursor == null || page.items.size == cap)
        val earlier = scan.pages.flatMap { it.items }
        val seen = earlier.map { it.id }.toSet()
        require(page.items.none { it.id in seen }) { "Repeated faucet recovery evidence." }
        require(page.nextCursor == null || scan.pages.none { it.nextCursor == page.nextCursor }) { "Faucet recovery cursor loop." }
        val ordered = listOfNotNull(earlier.lastOrNull()) + page.items
        require(ordered.zipWithNext().all { (newer, older) ->
            val comparison = Instant.parse(newer.requestedAt).compareTo(Instant.parse(older.requestedAt))
            comparison > 0 || comparison == 0 && newer.id > older.id
        }) { "Faucet recovery page order changed." }
        val next = scan.copy(pages = scan.pages + page)
        discovery = next
        mutable.update { it.copy(discoveryNextCursor = page.nextCursor) }
        val claimDay = scan.saved.claimDay
        if (claimDay == null) {
            // Owner rule 2026-10-06 (no saved request blocks play forever): a no-day intent cannot be matched to a grant,
            // so only a complete guarded scan in which every page held zero requested grants releases it.
            if (page.nextCursor == null && next.pages.all { it.items.isEmpty() })
                releaseUnsigned(scan.saved, scan.pin, scan.policy, scan.base, "No pending grant remains. Check again before another action.")
            return
        }
        val candidates = page.items.filter {
            Instant.parse(it.requestedAt).atOffset(ZoneOffset.UTC).toLocalDate().toString() == claimDay
        }
        require(candidates.size <= 1) { "Ambiguous faucet recovery evidence." }
        val observed = candidates.singleOrNull()
        if (observed != null) {
            // Owned grant for the reserved day, not proof this local request created it.
            journal.replace(scan.saved, scan.saved.copy(grant = observed, attemptId = observed.attempt?.id))
            resetDiscovery(); mutable.update { it.copy(grant = observed, uncertain = false) }
        } else if (page.nextCursor == null && scan.serverDay.isAfter(LocalDate.parse(claimDay))) {
            // review 8938311c M3: only a complete guarded sequence, after the
            // server-observed claim day, releases an unsigned grant-less intent.
            releaseUnsigned(scan.saved, scan.pin, scan.policy, scan.base,
                "No matching pending grant remains. Check again before another action.")
        }
    }
    /** One additional page only, on an explicit player Check older action. Never a money POST. */
    suspend fun discoverOlder() = action { pin, policy ->
        val saved = journal.read() ?: return@action
        val scan = discovery ?: return@action
        if (!unsignedGrantless(saved) || scan.saved != saved || scan.pin != pin || scan.policy != policy ||
            scan.base != selectedBase() || scan.epoch != capturedEpoch) { resetDiscovery(); return@action }
        val cursor = scan.pages.lastOrNull()?.nextCursor ?: return@action
        require(cursor == mutable.value.discoveryNextCursor)
        readDiscoveryPage(scan, cursor)
    }
    private suspend fun observeGrant(saved: SkrFaucetRecord, fresh: SkrFaucetGrant,
        pin: SkrIdentity, policy: SkrFaucetBounds, base: String?) {
        checkGrant(fresh, pin, policy)
        require(saved.grant?.sameIdentity(fresh) == true) { "Faucet grant identity changed." }
        // Unknown states retain every byte of recovery evidence and cannot advance the journal.
        if (!fresh.status.known || fresh.attempt?.phase?.known == false) return
        val matchingAttempt = fresh.attempt?.id == saved.attemptId
        val deadAttempt = fresh.attempt?.phase?.raw in setOf("failed", "expired", "abandoned")
        val next = saved.copy(grant = fresh, attemptId = fresh.attempt?.id,
            signedTransaction = if (matchingAttempt && !deadAttempt) saved.signedTransaction else null, preparePending = false)
        journal.replace(saved, next)
        mutable.update { it.copy(grant = fresh) }
        if (fresh.status.isValue("sent")) {
            refreshWallet(); contextGuard(base, pin, policy)
            journal.clear(next)
            mutable.update { it.copy(uncertain = false, arrival = fresh) }
        } else if (fresh.status.isValue("failed")) {
            journal.clear(next); mutable.update { it.copy(uncertain = false) }
        }
    }
    suspend fun refresh() = action { pin, policy -> readStatus(pin, policy, selectedBase()) }
    suspend fun claim() = action { pin, policy ->
        walletAvailable(); current()
        val base = requireNotNull(selectedBase()) { "Select a deed base." }
        require(UUID.fromString(base).toString() == base)
        val status = readStatus(pin, policy, base); guard(base, pin, policy)
        check(mutable.value.canClaim && journal.read() == null) { "Check the existing grant before claiming." }
        val saved = journal.beginIfEmpty(base, status.day)
        resetDiscovery()
        mutable.update { it.copy(uncertain = true, canClaim = false, grant = null, arrival = null, discoveryNextCursor = null) }
        try {
            val response = api.post("/devnet-skr-faucet/claim", buildJsonObject { put("baseId", base) }); contextGuard(base, pin, policy)
            val grant = decode("claim") { SkrFaucetGrant.from(response.getValue("grant").jsonObject) }
            checkGrant(grant, pin, policy)
            journal.replace(saved, saved.copy(grant = grant, attemptId = grant.attempt?.id))
            mutable.update { it.copy(grant = grant, uncertain = false,
                error = if (grant.status.known) null else "New grant state. Check again; saved evidence is preserved.") }
        } catch (error: ApiException) {
            contextGuard(base, pin, policy)
            if (error.status == 429 && error.code == "SKR_FAUCET_DAILY_LIMIT") {
                val grant = decode("claim") { SkrFaucetGrant.fromDailyLimit(error.details) }
                if (grant != null) {
                    checkGrant(grant, pin, policy)
                    require(grant.status.known && grant.attempt?.phase?.known != false) { "Unknown faucet conflict state." }
                    // A deed-day conflict can belong to another wallet; status/error DTOs omit the owner.
                    // The authorized read is the ownership proof before durable adoption.
                    val response = try { api.get("/devnet-skr-faucet/grants/${grant.id}") }
                    catch (refusal: ApiException) {
                        contextGuard(base, pin, policy)
                        if (refusal.status == 404 && refusal.code == "SKR_FAUCET_NOT_OWNED") {
                            releaseUnsigned(saved, pin, policy, base,
                                "No owned grant was found for this claim refusal. Check again before another action.")
                        }
                        throw refusal
                    }
                    contextGuard(base, pin, policy)
                    val owned = decode("grants/${grant.id}") { SkrFaucetGrant.from(response.getValue("grant").jsonObject) }
                    checkGrant(owned, pin, policy); require(grant.sameIdentity(owned))
                    journal.replace(saved, saved.copy(grant = owned, attemptId = owned.attempt?.id))
                    mutable.update { it.copy(grant = owned, uncertain = false) }
                }
            } else if (definitiveClaimRefusal(error)) {
                releaseUnsigned(saved, pin, policy, base, "The claim was refused. Check again before another action.")
            }
            throw error
        }
    }
    /** Explicit player action. Every new signature follows a fresh server prepare and structural review. */
    suspend fun prepareAndSign() = action { pin, policy ->
        walletAvailable(); current()
        val base = selectedBase(); val status = readStatus(pin, policy, base); guard(base, pin, policy)
        check(!releasedDuringAction) { "Check the faucet again before another approval." }
        check(status.enabled && status.reason.known && status.reason.raw in setOf("pending", "sign_required")) { "Faucet status is unavailable." }
        val grant = requireNotNull(status.today)
        checkGrant(grant, pin, policy)
        require(grant.status.isValue("requested") && grant.attempt?.phase?.known != false)
        require(grant.attempt?.phase?.raw !in setOf("player_signed", "submitted", "finalized")) { "The server is checking this attempt." }
        val existing = journal.read()
        require(existing == null || existing.grant != null) { "The earlier claim is unresolved. Check saved evidence before another approval." }
        if (existing?.grant != null) require(existing.grant.sameIdentity(grant))
        var saved = existing ?: journal.beginIfEmpty(requireNotNull(base), status.day)
        // A saved wire may have escaped to the server: observe/recover it before creating another signature.
        require(saved.signedTransaction == null) { "Check the saved signed attempt first." }
        var next = saved.copy(grant = grant, attemptId = grant.attempt?.id, preparePending = true)
        journal.replace(saved, next); saved = next
        guard(base, pin, policy)
        val response = api.post("/devnet-skr-faucet/prepare", buildJsonObject { put("grantId", grant.id) }); contextGuard(base, pin, policy)
        val prepared = decode("prepare") { SkrFaucetPrepared.from(response) }
        require(grant.sameIdentity(prepared.grant)); checkGrant(prepared.grant, pin, policy)
        next = saved.copy(grant = prepared.grant, attemptId = prepared.grant.attempt!!.id, preparePending = false)
        journal.replace(saved, next); saved = next
        mutable.update { it.copy(grant = prepared.grant, uncertain = false, networkFeeLamports = prepared.networkFeeLamports,
            accountRentLamports = prepared.accountRentLamports) }
        val walletPrepared = SkrFaucetClaimTransaction.prepare(session.wallet, pin.mint, pin.decimals,
            prepared.grant.amountRaw, policy.grantSkr, prepared.unsignedTransaction)
        guard(base, pin, policy)
        val signingRecord = saved
        signer(walletPrepared, { guard(base, pin, policy) }) { signed ->
            // Verification belongs to the signer as well; never trust a caller-constructed evidence record.
            val verified = walletPrepared.verifySigned(java.util.Base64.getDecoder().decode(signed.wire))
            require(verified.playerSignature == signed.playerSignature)
            withContext(NonCancellable) {
                journal.replace(signingRecord, signingRecord.copy(signedTransaction = verified.wire))
            }
        }
        guard(base, pin, policy)
        submitSaved(requireNotNull(journal.read()), pin, policy, base)
    }
    /** The only permitted retry is the same saved wire for the same server-prepared attempt. */
    suspend fun recover() = action { pin, policy ->
        val base = selectedBase(); val status = readStatus(pin, policy, base)
        val saved = journal.read() ?: return@action
        val fresh = status.today ?: return@action
        val freshAttempt = fresh.attempt ?: return@action
        if (status.enabled && status.reason.isValue("pending") && fresh.status.isValue("requested") && freshAttempt.phase.isValue("prepared") &&
            saved.grant?.sameIdentity(fresh) == true && saved.attemptId == freshAttempt.id && saved.signedTransaction != null) {
            guard(base, pin, policy); submitSaved(saved, pin, policy, base)
        }
    }
    private suspend fun submitSaved(saved: SkrFaucetRecord, pin: SkrIdentity, policy: SkrFaucetBounds, base: String?) {
        val wire = requireNotNull(saved.signedTransaction); val attempt = requireNotNull(saved.attemptId)
        walletAvailable()
        guard(base, pin, policy)
        try {
            val response = api.post("/devnet-skr-faucet/submit", buildJsonObject { put("attemptId", attempt); put("signedTransaction", wire) }); contextGuard(base, pin, policy)
            val grant = decode("submit") { SkrFaucetGrant.from(response.getValue("grant").jsonObject) }
            checkGrant(grant, pin, policy)
            require(saved.grant?.sameIdentity(grant) == true && grant.attempt?.id == attempt)
            journal.replace(saved, saved.copy(grant = grant))
            mutable.update { it.copy(grant = grant) }
        } catch (error: ApiException) {
            contextGuard(base, pin, policy)
            if (error.code in setOf("SKR_FAUCET_BLOCKHASH_CHANGED", "SKR_FAUCET_ATTEMPT_CONFLICT", "SKR_FAUCET_NOT_OWNED")) {
                // A new prepare requires a new explicit player action, never an automatic mutation.
                journal.replace(saved, saved.copy(signedTransaction = null, preparePending = false))
            }
            throw error
        }
    }
    suspend fun foreground() {
        recover()
        observeForeground()
    }
    suspend fun observeForeground() {
        refresh()
        while (currentCoroutineContext().isActive) {
            val poll = bounds()?.pollMs ?: return
            if (identity() == null) return
            delay(poll); refresh()
        }
    }
    private inline fun <T> decode(route: String, block: () -> T): T = try { block() }
        catch (_: Exception) { throw ApiCompatibilityException("/devnet-skr-faucet/$route") }
    /** Actual P5 /claim HttpError paths before admission commits (review 8938311c).
     * Future/uncoded/proxy/transport errors and SKR_FAUCET_UNAVAILABLE stay ambiguous. */
    private fun definitiveClaimRefusal(error: ApiException): Boolean {
        val expectedStatus = when (error.code) {
            "SKR_FAUCET_DISABLED", "SKR_FAUCET_UNCONFIGURED", "SKR_FAUCET_MINT_CHANGED", "DEED_AUTHORITY_UNAVAILABLE" -> 503
            "SKR_FAUCET_DAY_CHANGED", "SKR_FAUCET_DEED_REQUIRED", "DEED_OWNERSHIP_CHANGED", "BASE_ID_REQUIRED" -> 409
            "SKR_FAUCET_INVALID_REQUEST" -> 400
            "BASE_NOT_OWNED" -> 404
            else -> return false
        }
        return error.status == expectedStatus
    }
    private fun errorText(error: Exception): String = when ((error as? ApiException)?.code) {
        "SKR_FAUCET_SOL_FOR_FEE" -> "Needs SOL for the network fee and any account rent."
        "SKR_FAUCET_DEED_REQUIRED", "DEED_OWNERSHIP_CHANGED", "DEED_AUTHORITY_UNAVAILABLE" -> "Check deed ownership and try again."
        "SKR_FAUCET_DAILY_LIMIT" -> "Today's grant is already reserved. Check its status."
        "SKR_FAUCET_DAY_CHANGED" -> "The claim day changed. Check the server's current grant."
        "SKR_FAUCET_BLOCKHASH_CHANGED" -> "The wallet changed the blockhash. Prepare a new attempt."
        "SKR_FAUCET_NOT_OWNED", "SKR_FAUCET_ATTEMPT_CONFLICT" -> "The saved attempt changed. Check again."
        else -> "Faucet unavailable. Saved claim evidence is preserved; check again."
    }
}
