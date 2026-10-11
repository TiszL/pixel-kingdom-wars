package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

enum class EconomyPage(val title: String) { WALLET("Wallet"), FORGE("Gold Forge"), WITHDRAWALS("Withdrawals"), OVERVIEW("Economy"), SUPPORT("Faucet & referrals") }
data class EconomyState(val baseId: String? = null, val wallet: WalletFunds? = null, val balances: Balances? = null,
    val forge: ForgeOverview? = null, val allocations: ForgeAllocations? = null, val allowance: WithdrawalAllowance? = null,
    val withdrawals: List<WithdrawalRecord>? = null, val totals: EconomyTotals? = null, val faucet: FaucetOverview? = null,
    val referrals: ReferralOverview? = null, val loading: Boolean = false, val errors: Map<String, String> = emptyMap(),
    val conversionSupported: Boolean = false, val contributionSupported: Boolean = false, val keepRate: Long? = null,
    val accepted: EconomyAcceptance? = null, val withdrawalSupported: Boolean = false, val instantEligible: Boolean = false,
    val confirmedWithdrawal: WithdrawalAcceptance? = null,
    val forgeGlobal: ForgeGlobal? = null, val forgeGlobalDay: String? = null, val forgeGlobalBaseId: String? = null,
    val forgeGlobalLoading: Boolean = false, val forgeGlobalError: String? = null,
    val forgeReady: Boolean = false, val allocationBaseId: String? = null)
data class EconomyReview(val wallet: String, val baseId: String?, val action: EconomyAction, val amount: String, val rate: Long?)
data class WithdrawalReview(val wallet: String, val baseId: String?, val quote: WithdrawalQuote)

interface EconomyRepository {
    val state: StateFlow<EconomyState>
    suspend fun refresh(page: EconomyPage)
    suspend fun moreAllocations()
    suspend fun refreshGlobal(day: String? = null)
    suspend fun moreGlobal()
    val interrupted: StateFlow<List<InterruptedIntent>>
    suspend fun review(action: EconomyAction, amount: String): EconomyReview
    suspend fun confirm(review: EconomyReview)
    suspend fun check(kind: String): Receipt<*>?
    /** CLOSE on the herald (owner 2026-10-06): the observer's closure of this kind (one more GET; forgotten on this device
     * only after the server answered `unknown` for that key). Default: nothing to close. */
    suspend fun close(kind: String): Receipt<*>? = null
    suspend fun prepareWithdrawal(amount: String, destination: String, instant: Boolean): WithdrawalReview
    suspend fun confirmWithdrawal(review: WithdrawalReview, code: String, authorize: suspend (JsonObject) -> WithdrawalAuthorization)
}

/** Balances and history never prove acceptance. Money requests require exact immutable receipts. */
class LiveEconomyRepository(private val session: AccountSession, private val holder: AccountSessionHolder, private val api: ApiClient,
    private val selectedBaseId: () -> String?, private val landOwned: () -> Boolean,
    intents: PendingIntentStore, private val observer: ReceiptObserver,
    private val refreshAccount: suspend () -> Unit = {},
    /** The wallet's SOL read through the session RPC relay, as the web's useSolBalance does. Used only
     * when the server's own read carries no SOL (a candidate host has no upstream RPC; production may
     * be mid-outage): the chip then shows the chain's answer instead of "…". Null = no relay read. */
    private val solBalance: (suspend () -> String?)? = null) : EconomyRepository {
    private val mutable = MutableStateFlow(EconomyState())
    override val state = mutable.asStateFlow()
    private val admission = Mutex()
    private val globalReads = Mutex()
    private val scopedReads = AtomicLong()

    /** Fence pre-claim reads before waiting for their admission lock. No stale amount stays actionable. */
    fun invalidateForge() {
        holder.requireCurrent(session); scopedReads.incrementAndGet()
        mutable.update { it.copy(balances = null, forge = null, allocations = null, forgeReady = false) }
    }

    /** Refresh one current scoped snapshot; the receipt remains the sole proof of the original claim. */
    suspend fun refreshForgeAfterClaim(originalBase: String?, unavailable: String?): ForgeClaimRefresh {
        val ticket = scopedReads.get(); val base = selectedBaseId(); val owned = landOwned()
        fun valid() { current(base); checkRead(ticket); if (landOwned() != owned) throw CancellationException("Allocation scope changed") }
        valid()
        return admission.withLock {
            valid(); mutable.update { it.copy(loading = true, forgeReady = false) }
            try {
                // Only the original available scope is required to finish receipt recovery.
                // Current gameplay routes may be disabled or there may be no active deed left.
                val original = if (unavailable == null) api.get("/balances", query(originalBase)).also { valid() } else null
                val originalKeep = original?.let { ForgeClaimContract.text(it, "keep").also(ForgeClaimContract::amount) }
                try {
                    val raw = if (originalBase == base && original != null) original else api.get("/balances", query(base)).also { valid() }
                    val forge = if (owned) ForgeOverview.from(api.get("/forge", query(base))).also { valid() } else null
                    val allocations = ForgeAllocations.from(api.get("/forge/allocations", query(if (owned) base else null))); valid()
                    mutable.update { balances(it, raw).copy(baseId = base, forge = forge, allocations = allocations,
                        allocationBaseId = if (owned) base else null, forgeReady = true,
                        errors = it.errors - setOf("/balances", "/forge", "/forge/allocations")) }
                    ForgeClaimRefresh(originalKeep, unavailable)
                } catch (error: CancellationException) { throw error }
                catch (_: Exception) {
                    valid()
                    // Failure of an unrelated current screen cannot disprove or strand an exact receipt.
                    ForgeClaimRefresh(originalKeep, unavailable, availabilityCurrent = false,
                        availabilityUnavailable = "Collected. Current Forge availability could not be updated.")
                }
            } finally { if (holder.isCurrent(session) && ticket == scopedReads.get()) mutable.update { it.copy(loading = false) } }
        }
    }
    private fun checkRead(ticket: Long) { if (ticket != scopedReads.get()) throw CancellationException("Forge snapshot superseded") }
    override val interrupted = observer.interrupted
    private val transport = object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>) = api.get(path, query)
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            require(path == KeepConversionSpec.path || path == ForgeContributionSpec.path)
            api.post(path, body)
            // Once POST returned, no GET failure can disprove its acceptance.
            // A 401/404 here must retain the attempted journal just like a timeout.
            return try {
                api.get("$path/receipt", body.mapValues { it.value.jsonPrimitive.content }).also {
                    if (it["status"] != JsonPrimitive("accepted")) throw IOException("Acceptance is not yet confirmed.")
                }
            }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { throw IOException("Request sent. Check its saved status to confirm the result.", error) }
        }
    }
    private val conversion = MoneyOp(KeepConversionSpec, intents, transport)
    private val contribution = MoneyOp(ForgeContributionSpec, intents, transport)
    private var authorizedWithdrawal: (suspend (JsonObject) -> JsonObject)? = null
    private val withdrawal = MoneyOp(WithdrawalSpec, intents, object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>) = api.get(path, query)
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            require(path == WithdrawalSpec.PATH)
            return requireNotNull(authorizedWithdrawal) { "A fresh wallet confirmation is required." }(body)
        }
    })
    init {
        observer.register(conversion) { hydrate(it.value) }
        observer.register(contribution) { hydrate(it.value) }
        observer.register(withdrawal) { hydrateWithdrawal(it.value) }
    }
    private fun balances(state: EconomyState, raw: JsonObject): EconomyState {
        val features = raw["features"] as? JsonObject
        fun supported(name: String) = (features?.get(name) as? JsonObject)?.get("version") == JsonPrimitive(1)
        val rate = runCatching { economyRate(raw["keepRate"]) }.getOrNull()
        return state.copy(balances = Balances.from(raw), keepRate = rate,
            conversionSupported = supported("conversionReceipts"), contributionSupported = supported("forgeContributionReceipts"))
    }
    private suspend fun loadBalances(base: String?) {
        val ticket = scopedReads.get()
        mutable.update { it.copy(conversionSupported = false, contributionSupported = false) }
        val raw = api.get("/balances", query(base)); current(base); checkRead(ticket)
        mutable.value = balances(mutable.value, raw).copy(baseId = base, errors = mutable.value.errors - "/balances")
    }
    override suspend fun review(action: EconomyAction, amount: String): EconomyReview = admission.withLock {
        val base = selectedBaseId(); current(base)
        require(amount.length <= 32 && amount.matches(Regex("[1-9][0-9]*"))) { "Enter a positive whole amount." }
        loadBalances(base)
        if (action == EconomyAction.CONTRIBUTE) {
            check(landOwned()) { "A Land Deed is required to contribute." }
            val raw = api.get("/forge", query(base)); current(base)
            mutable.update { it.copy(forge = ForgeOverview.from(raw)) }
        }
        val reviewed = EconomyReview(session.wallet, base, action, amount, mutable.value.keepRate)
        validate(reviewed); reviewed
    }
    private fun validate(review: EconomyReview) {
        current(review.baseId); require(review.wallet == session.wallet)
        val amount = review.amount.toBigInteger(); val state = mutable.value
        if (review.action == EconomyAction.CONVERT) {
            check(state.conversionSupported && review.rate != null) { "Conversions need a server update. Refresh when it is available." }
            check(conversion.blocking(session.wallet) == null) { "Check your interrupted conversion first." }
            require(review.rate == state.keepRate) { "The conversion rate changed. Review it again." }
            require(amount <= requireNotNull(state.balances).keep.toBigInteger()) { "Not enough KEEP." }
        } else {
            check(state.contributionSupported) { "Contributions need a server update. Refresh when it is available." }
            check(contribution.blocking(session.wallet) == null) { "Check your interrupted contribution first." }
            check(landOwned()) { "A Land Deed is required to contribute." }
            val forge = requireNotNull(state.forge) { "Load the Gold Forge first." }
            require(amount <= forge.balance.toBigInteger()) { "Not enough SHARDS." }
            require(amount <= forge.dailyCap.toBigInteger() - forge.myShards.toBigInteger()) { "This amount exceeds the remaining daily cap." }
        }
    }
    override suspend fun confirm(review: EconomyReview) = admission.withLock {
        current(review.baseId); require(review.wallet == session.wallet)
        loadBalances(review.baseId)
        if (review.action == EconomyAction.CONTRIBUTE) {
            val raw = api.get("/forge", query(review.baseId)); current(review.baseId)
            mutable.update { it.copy(forge = ForgeOverview.from(raw), errors = it.errors - "/forge") }
        }
        validate(review)
        val spec = if (review.action == EconomyAction.CONVERT) KeepConversionSpec else ForgeContributionSpec
        val op = if (review.action == EconomyAction.CONVERT) conversion else contribution
        val intent = spec.intent(session.wallet, review.baseId, UUID.randomUUID().toString(), review.amount)
        try { op.submit(intent) { hydrate(it.value) } }
        finally { observer.refresh(session.wallet) }
        Unit
    }
    override suspend fun check(kind: String): Receipt<*>? = admission.withLock {
        holder.requireCurrent(session)
        require(kind in setOf(IntentKind.KEEP_CONVERSION, IntentKind.FORGE_CONTRIBUTION, IntentKind.WITHDRAWAL))
        observer.check(kind, session.wallet)
    }
    override suspend fun close(kind: String): Receipt<*>? = admission.withLock {
        holder.requireCurrent(session)
        require(kind in setOf(IntentKind.KEEP_CONVERSION, IntentKind.FORGE_CONTRIBUTION, IntentKind.WITHDRAWAL))
        observer.close(kind, session.wallet)
    }
    private fun withdrawals(state: EconomyState, raw: JsonObject) = state.copy(withdrawals = WithdrawalRecord.list(raw),
        withdrawalSupported = ((raw["features"] as? JsonObject)?.get("withdrawalReceipts") as? JsonObject)?.get("version") == JsonPrimitive(1))
    private suspend fun loadWithdrawals() {
        mutable.update { it.copy(withdrawalSupported = false) }
        val raw = api.get("/withdrawals"); holder.requireCurrent(session)
        mutable.value = withdrawals(mutable.value, raw).copy(errors = mutable.value.errors - "/withdrawals")
    }
    private suspend fun requireInstantEligible() {
        val raw = api.get("/2fa/status"); holder.requireCurrent(session)
        val eligible = raw["instantEligible"] == JsonPrimitive(true) && raw["instantWithdrawalsEnabled"] == JsonPrimitive(true)
        mutable.update { it.copy(instantEligible = eligible) }
        check(eligible) { "Instant withdrawals require an eligible authenticator and an available payout service." }
    }
    override suspend fun prepareWithdrawal(amount: String, destination: String, instant: Boolean): WithdrawalReview = admission.withLock {
        val base = selectedBaseId(); current(base)
        require(amount.length <= 32 && amount.matches(Regex("[1-9][0-9]*"))) { "Enter a positive whole KEEP amount." }
        require(destination.length in 32..44 && destination.matches(Regex("[1-9A-HJ-NP-Za-km-z]+"))) { "Enter a valid Solana wallet address." }
        check(landOwned()) { "A Land Deed is required for new withdrawals." }
        check(withdrawal.blocking(session.wallet) == null) { "Check your interrupted withdrawal first." }
        loadWithdrawals(); current(base)
        check(mutable.value.withdrawalSupported) { "Withdrawals need a server update. Refresh when it is available." }
        if (instant) requireInstantEligible()
        val key = UUID.randomUUID().toString()
        val raw = api.post("/withdrawals/prepare", buildJsonObject {
            put("amount", amount); put("destination", destination); put("idempotencyKey", key); put("instant", instant)
        })
        current(base)
        val quote = try { WithdrawalQuote(raw).also { require(it.gross == amount && it.destination == destination && it.key == key && it.instant == instant) } }
        catch (_: Exception) { throw ApiCompatibilityException("/withdrawals/prepare") }
        WithdrawalReview(session.wallet, base, quote)
    }
    override suspend fun confirmWithdrawal(review: WithdrawalReview, code: String, authorize: suspend (JsonObject) -> WithdrawalAuthorization) = admission.withLock {
        current(review.baseId); require(review.wallet == session.wallet)
        check(landOwned()) { "A Land Deed is required for new withdrawals." }
        check(withdrawal.blocking(session.wallet) == null) { "Check your interrupted withdrawal first." }
        if (review.quote.instant) require(code.matches(Regex("[0-9]{6,8}"))) { "Enter a current PKW authenticator code." }
        else require(code.isEmpty())
        loadWithdrawals(); current(review.baseId)
        check(mutable.value.withdrawalSupported) { "Withdrawals need a server update. Refresh when it is available." }
        if (review.quote.instant) requireInstantEligible()
        val proof = authorize(review.quote.intent); current(review.baseId)
        val intent = WithdrawalSpec.intent(session.wallet, review.baseId, review.quote)
        authorizedWithdrawal = { body ->
            current(review.baseId); require(body == intent.body)
            proof.post(api, body, code)
            val receipt = WithdrawalSpec.receiptRequest(intent)
            try {
                api.get(receipt.path, receipt.query).also {
                    if (it["status"] != JsonPrimitive("accepted")) throw IOException("Acceptance is not yet confirmed.")
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { throw IOException("Withdrawal sent. Check its saved status to confirm the result.", error) }
        }
        try { withdrawal.submit(intent) { hydrateWithdrawal(it.value) } }
        finally { authorizedWithdrawal = null; observer.refresh(session.wallet) }
        Unit
    }
    private suspend fun hydrateWithdrawal(accepted: WithdrawalAcceptance) {
        holder.requireCurrent(session); refreshAccount(); holder.requireCurrent(session)
        val base = selectedBaseId()
        mutable.update { it.copy(baseId = base, balances = null, forge = null, allocations = null) }
        try { loadBalances(base) }
        catch (error: ApiException) { if (base != null || error.status != 409 || error.code != "BASE_ID_REQUIRED") throw error }
        loadWithdrawals(); current(base)
        // Terminal history is capped. Its absence cannot undo exact escrow acceptance;
        // a successful list read may still leave the current payout status unavailable.
        mutable.value.withdrawals?.find { it.id == accepted.withdrawalId }?.let { row ->
            require(row.gross == accepted.quote.gross && row.fee == accepted.quote.fee && row.net == accepted.quote.net
                && row.destination == accepted.quote.destination && row.unbondsAt == accepted.unbondsAt) { "Withdrawal history does not match its original receipt." }
        }
        mutable.update { it.copy(confirmedWithdrawal = accepted) }
    }
    private suspend fun hydrate(accepted: EconomyAcceptance) {
        holder.requireCurrent(session); refreshAccount(); holder.requireCurrent(session)
        val base = selectedBaseId()
        // Historical proofs retain their original base. Refresh only the current
        // account's selected snapshot; never fetch a buyer's private Forge state.
        mutable.update { it.copy(baseId = base, balances = null, forge = null, allocations = null) }
        try { loadBalances(base) }
        catch (error: ApiException) {
            if (base != null || error.status != 409 || error.code != "BASE_ID_REQUIRED") throw error
        }
        current(base)
        if (accepted.action == EconomyAction.CONTRIBUTE && landOwned()) {
            try {
                val raw = api.get("/forge", query(base)); current(base)
                mutable.update { it.copy(forge = ForgeOverview.from(raw), errors = it.errors - "/forge") }
            } catch (error: ApiException) {
                if (error.status != 404) throw error
                mutable.update { it.copy(errors = it.errors + ("/forge" to "Gold Forge is currently unavailable.")) }
            }
        }
        current(base)
        mutable.update { it.copy(accepted = accepted) }
    }
    private fun current(base: String?) { holder.requireCurrent(session); if (base != selectedBaseId()) throw CancellationException("Selected base changed") }
    private fun query(base: String?) = base?.let { mapOf("baseId" to it) }.orEmpty()
    /** Presentation fallback only: never a spend, never retried, silent on failure (the chip keeps "…"). */
    private suspend fun fillSolFromRelay(base: String?, ticket: Long) {
        val relay = solBalance ?: return
        if (mutable.value.wallet?.sol != null) return
        val sol = try { relay() } catch (error: CancellationException) { throw error } catch (_: Exception) { null } ?: return
        current(base); checkRead(ticket)
        mutable.update { it.copy(wallet = (it.wallet ?: WalletFunds(null, emptyMap(), 0L)).copy(sol = sol, asOf = System.currentTimeMillis())) }
    }
    private suspend fun read(path: String, base: String?, query: Map<String, String> = emptyMap(), ticket: Long = scopedReads.get(), accept: (EconomyState, JsonObject) -> EconomyState) {
        try {
            checkRead(ticket); val raw = api.get(path, query); current(base); checkRead(ticket)
            val next = try { accept(mutable.value, raw) } catch (_: Exception) { throw ApiCompatibilityException(path) }
            mutable.value = next.copy(errors = next.errors - path)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            current(base); checkRead(ticket)
            val message = if (error is ApiException && error.status == 404) "Unavailable on this server." else error.message ?: "Connection interrupted. Retry to update."
            mutable.update { it.copy(errors = it.errors + (path to message)) }
        }
    }
    override suspend fun refresh(page: EconomyPage) = admission.withLock {
        val ticket = scopedReads.get()
        val base = selectedBaseId(); current(base)
        if (mutable.value.baseId != base) mutable.update { it.copy(baseId = base, balances = null, forge = null, allocations = null, errors = it.errors.filterKeys { key -> key == "/wallet/balances" }, conversionSupported = false, contributionSupported = false) }
        if (mutable.value.forgeGlobalBaseId != base) mutable.update { it.copy(forgeGlobal = null, forgeGlobalDay = null, forgeGlobalBaseId = base, forgeGlobalError = null) }
        observer.refresh(session.wallet)
        mutable.update { it.copy(loading = true) }
        try {
            when (page) {
                EconomyPage.WALLET -> {
                    mutable.update { it.copy(conversionSupported = false, contributionSupported = false) }
                    read("/balances", base, query(base)) { s, r -> balances(s, r) }
                    read("/wallet/balances", base) { s, r -> s.copy(wallet = WalletFunds.from(r)) }
                    fillSolFromRelay(base, ticket)
                }
                EconomyPage.FORGE -> {
                    val owned = landOwned()
                    mutable.update { it.copy(conversionSupported = false, contributionSupported = false, forgeReady = false, allocations = null) }
                    read("/balances", base, query(base), ticket) { s, r -> balances(s, r) }
                    if (owned) read("/forge", base, query(base), ticket) { s, r -> s.copy(forge = ForgeOverview.from(r)) }
                    else mutable.update { it.copy(forge = null, errors = it.errors + ("/forge" to "A Land Deed unlocks new Forge contributions.")) }
                    read("/forge/allocations", base, query(if (owned) base else null), ticket) { s, r -> s.copy(allocations = ForgeAllocations.from(r)) }
                    checkRead(ticket); current(base)
                    if (landOwned() != owned) throw CancellationException("Allocation scope changed")
                    mutable.update { it.copy(allocationBaseId = if (owned) base else null,
                        forgeReady = it.allocations != null && it.errors["/forge/allocations"] == null) }
                }
                EconomyPage.WITHDRAWALS -> {
                    mutable.update { it.copy(withdrawalSupported = false, instantEligible = false) }
                    read("/withdrawals", base) { s, r -> withdrawals(s, r) }
                    if (mutable.value.withdrawalSupported) read("/2fa/status", base) { s, r -> s.copy(instantEligible =
                        r["instantEligible"] == JsonPrimitive(true) && r["instantWithdrawalsEnabled"] == JsonPrimitive(true)) }
                    if (landOwned()) read("/withdrawals/status", base) { s, r -> s.copy(allowance = WithdrawalAllowance.from(r)) }
                    else mutable.update { it.copy(allowance = null, errors = it.errors + ("/withdrawals/status" to "A Land Deed is required for new withdrawals. Existing history remains available.")) }
                }
                EconomyPage.OVERVIEW -> read("/economy/stats", base) { s, r -> s.copy(totals = EconomyTotals.from(r)) }
                EconomyPage.SUPPORT -> {
                    read("/devnet-faucet/status", base) { s, r -> s.copy(faucet = FaucetOverview.from(r)) }
                    read("/referrals/code", base) { s, r -> s.copy(referrals = ReferralOverview.from(r)) }
                }
            }
        } finally { if (holder.isCurrent(session) && ticket == scopedReads.get()) mutable.update { it.copy(loading = false) } }
    }
    override suspend fun moreAllocations() = admission.withLock {
        val ticket = scopedReads.get()
        val base = selectedBaseId(); current(base)
        if (mutable.value.baseId != base) return@withLock
        val previous = mutable.value.allocations ?: return@withLock
        val cursor = previous.nextBefore ?: return@withLock
        mutable.update { it.copy(loading = true) }
        try { read("/forge/allocations", base, query(if (landOwned()) base else null) + ("before" to cursor), ticket) { s, r ->
            val next = ForgeAllocations.from(r)
            require(next.days.all { it.day < cursor })
            require(next.nextBefore?.let { it < cursor } != false)
            s.copy(allocations = next.copy(days = previous.days + next.days))
        } } finally { if (holder.isCurrent(session) && ticket == scopedReads.get()) mutable.update { it.copy(loading = false) } }
    }

    /** This public history never selects a deed or participates in the money-operation admission. */
    override suspend fun refreshGlobal(day: String?) = globalReads.withLock {
        val base = selectedBaseId(); current(base)
        mutable.update { it.copy(forgeGlobal = it.forgeGlobal.takeIf { _ -> it.forgeGlobalBaseId == base && it.forgeGlobalDay == day },
            forgeGlobalBaseId = base, forgeGlobalDay = day, forgeGlobalLoading = true, forgeGlobalError = null) }
        try {
            require(day == null || day.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) { "Choose a settled Forge day." }
            val next = readGlobal(base, day?.let { mapOf("day" to it) }.orEmpty())
            require(day == null || next.day == day) { "The Forge cycle changed. Refresh its history." }
            require(next.rows.firstOrNull()?.rank?.let { it == 1 } != false) { "The Forge cycle returned an incomplete first page." }
            mutable.update { it.copy(forgeGlobal = next) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { globalError(base, error) }
        finally { if (holder.isCurrent(session)) mutable.update { it.copy(forgeGlobalLoading = false) } }
    }

    override suspend fun moreGlobal() = globalReads.withLock {
        val base = selectedBaseId(); current(base)
        val previous = mutable.value.forgeGlobal ?: return@withLock
        if (mutable.value.forgeGlobalBaseId != base) return@withLock
        val day = previous.day ?: return@withLock
        val cursor = previous.nextCursor ?: return@withLock
        mutable.update { it.copy(forgeGlobalLoading = true, forgeGlobalError = null) }
        try {
            val next = readGlobal(base, mapOf("day" to day, "cursor" to cursor))
            // Cursor contents are opaque. Require a progressing settled page of the same cycle;
            // a repeated or mismatched response must not duplicate or replace the retained rows.
            require(next.day == day && next.settled && next.nextCursor != cursor && next.rows.isNotEmpty()
                && next.rows.first().rank.toLong() == previous.rows.last().rank.toLong() + 1
                && next.contributors == previous.contributors && next.totalShards == previous.totalShards && next.distributedKeep == previous.distributedKeep) {
                "The Forge cycle changed. Refresh its history before loading more."
            }
            mutable.update { it.copy(forgeGlobal = previous.copy(rows = previous.rows + next.rows, nextCursor = next.nextCursor)) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { globalError(base, error) }
        finally { if (holder.isCurrent(session)) mutable.update { it.copy(forgeGlobalLoading = false) } }
    }

    private suspend fun readGlobal(base: String?, query: Map<String, String>): ForgeGlobal {
        val raw = api.get("/forge/global", query); current(base)
        return try { ForgeGlobal.from(raw) } catch (_: Exception) { throw ApiCompatibilityException("/forge/global") }
    }
    private fun globalError(base: String?, error: Exception) {
        current(base)
        val message = if (error is ApiException && error.status == 404) "Settled Forge cycles are unavailable on this server."
            else error.message ?: "Connection interrupted. Retry to update."
        mutable.update { it.copy(forgeGlobalError = message) }
    }
}
