package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionAuthenticatedPort
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionBidRequest
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionPrepared
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionProtocolPolicy
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionRecoveryPhase
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionRefusal
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionRefusalKind
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionSignedAttempt
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionSourcedRoundView
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionSubmission
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionTransport
import gg.pixelkingdomwars.nativeclient.seekerauction.SeekerAuctionWithdrawRequest
import gg.pixelkingdomwars.nativeclient.seekerauction.seekerAuctionRecovery
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.telemetry.reportWalletFailure
import gg.pixelkingdomwars.nativeclient.wallet.SeekerAuctionPin
import gg.pixelkingdomwars.nativeclient.wallet.SeekerAuctionTransaction
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster
import gg.pixelkingdomwars.nativeclient.wallet.SolanaRpc
import gg.pixelkingdomwars.nativeclient.wallet.WalletFailureReason
import gg.pixelkingdomwars.nativeclient.wallet.WalletPayment
import gg.pixelkingdomwars.nativeclient.wallet.WalletPaymentException
import java.math.BigInteger
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** The auction protocol policy from the admitted constants catalogue only (PHASE_E_POLICY.seekerIsland,
 * PHASE_E_SEEKER_AUCTION, PHASE_E_SEEKER_AUCTION_RUNTIME); null while content is missing or malformed. */
fun seekerAuctionProtocolPolicy(catalogue: JsonObject?): SeekerAuctionProtocolPolicy? = runCatching {
    val c = requireNotNull(catalogue?.get("constants") as? JsonObject)
    fun obj(parent: JsonObject, name: String) = requireNotNull(parent[name] as? JsonObject)
    fun int(parent: JsonObject, name: String): Int {
        val p = requireNotNull(parent[name] as? JsonPrimitive); require(!p.isString)
        return requireNotNull(p.intOrNull)
    }
    val island = obj(obj(c, "PHASE_E_POLICY"), "seekerIsland")
    SeekerAuctionProtocolPolicy(int(island, "totalSpots"), int(island, "kingSpots"), int(island, "realmCount"),
        int(obj(c, "PHASE_E_SEEKER_AUCTION"), "regularRealmCount"), int(obj(c, "PHASE_E_SEEKER_AUCTION_RUNTIME"), "refundPageSize"))
        .also { it.validate() }
}.getOrNull()

/** Turns a server-prepared message into the unsigned single-signer wire the shared payment rail hands to the wallet, or
 * throws IllegalArgumentException. The live binding is [seekerAuctionPinnedVerifier]; nothing else may build wallet bytes. */
interface SeekerAuctionVerifier {
    suspend fun bid(prepared: SeekerAuctionPrepared, reviewed: SeekerAuctionBidRequest): ByteArray
    suspend fun withdraw(prepared: SeekerAuctionPrepared, reviewed: SeekerAuctionWithdrawRequest): ByteArray
}

/** The S-B verifier bound to this build's pins and the session wallet: a message for another program, mint, wallet,
 * round, spot or amount is refused before any wallet sees it. */
internal fun seekerAuctionPinnedVerifier(pins: SeekerAuctionPins, wallet: String): SeekerAuctionVerifier {
    val pin = SeekerAuctionPin(pins.programId, pins.mint)
    return object : SeekerAuctionVerifier {
        override suspend fun bid(prepared: SeekerAuctionPrepared, reviewed: SeekerAuctionBidRequest): ByteArray {
            val checked = SeekerAuctionTransaction.bid(prepared, reviewed, pin, wallet)
            require(checked.wallet == wallet && checked.round == reviewed.round && checked.spot == reviewed.spot &&
                checked.newTotalRaw == reviewed.newTotalRaw) { "The auction message differs from the reviewed action" }
            return checked.unsignedTransaction()
        }
        override suspend fun withdraw(prepared: SeekerAuctionPrepared, reviewed: SeekerAuctionWithdrawRequest): ByteArray {
            val checked = SeekerAuctionTransaction.withdraw(prepared, reviewed, pin, wallet)
            require(checked.wallet == wallet && checked.round == reviewed.round && checked.spot == reviewed.spot &&
                checked.newTotalRaw == null) { "The auction message differs from the reviewed action" }
            return checked.unsignedTransaction()
        }
    }
}

/** The design's money sequence after the Seal (SPEC §3.6): CHECK_WALLET while the server prepares and the wallet asks,
 * SENDING once the wallet answered, SENT only after a finalized receipt AND a refreshed round view, FAILED otherwise. */
enum class SeekerAuctionStage { CHECK_WALLET, SENDING, SENT, FAILED }
enum class SeekerAuctionNotice { NO_WALLET, UNAVAILABLE, REFRESH_REQUIRED, NOT_REVIEWED, NOTHING_SENT, CHECKING, CHAIN_FAILED, NOT_LANDED }
data class SeekerAuctionTarget(val kind: SeekerAuctionKind, val round: String, val spot: Int)

/** [current]/[previous] are the last good round views (a failed routine read sets [readFailed] and keeps them);
 * [readAtMs] is the monotonic time of the current read, for the mapper's chain-time estimate. [pending] are the saved,
 * unresolved wallet steps (a spot with one reads as checking, never as a fresh BID). [action]/[stage]/[notice] belong to
 * the last bid or withdrawal; [noticeText] is its line. [journalUnreadable]: saved evidence cannot be read, so no new
 * wallet step is offered. */
data class SeekerAuctionState(val current: SeekerAuctionSourcedRoundView? = null, val previous: SeekerAuctionSourcedRoundView? = null,
    val readAtMs: Long? = null, val loading: Boolean = false, val readFailed: Boolean = false, val busy: Boolean = false,
    val action: SeekerAuctionTarget? = null, val stage: SeekerAuctionStage? = null, val notice: SeekerAuctionNotice? = null,
    val noticeText: String? = null, val pending: List<SeekerAuctionAttempt> = emptyList(), val journalUnreadable: Boolean = false)

/** The line for a notice. [server] is the server's own refusal text (409 SEEKER_AUCTION_REFRESH_REQUIRED). */
fun seekerAuctionNoticeText(notice: SeekerAuctionNotice, server: String? = null): String = when (notice) {
    SeekerAuctionNotice.NO_WALLET -> "A compatible Solana wallet app is needed."
    SeekerAuctionNotice.UNAVAILABLE -> "Can't reach the auction"
    SeekerAuctionNotice.REFRESH_REQUIRED -> server?.takeIf { it.isNotBlank() } ?: "This changed since you reviewed it. Check again."
    SeekerAuctionNotice.NOT_REVIEWED -> "This changed since you reviewed it. Check again."
    SeekerAuctionNotice.NOTHING_SENT -> "Wallet didn't answer. Nothing was sent."
    SeekerAuctionNotice.CHECKING -> "No answer yet. Checking whether it went through."
    SeekerAuctionNotice.CHAIN_FAILED -> "The network refused it. No SKR moved."
    SeekerAuctionNotice.NOT_LANDED -> "It never reached the network. No SKR moved."
}

/**
 * The Seeker island auction for one signed-in wallet (plan onchain-client-reach.md §5.4 S-C).
 *
 * Reads: the current round and the round before it (GET only; a failed routine read keeps what is shown). A view whose
 * program, mint or decimals differ from [pins] is refused as unavailable.
 * Bid / withdraw: fresh server prepare → the increment must equal what the Seal showed → [verifier] (the S-B pin check) →
 * the attempt is saved → ONE wallet step through the shared [ExternalPaymentRail] ([WalletLogin.pay]: the wallet's send,
 * or the same-session sign-only fallback relayed once through the RPC proxy) → `POST /submit {signature}` → `GET
 * /tx/:signature` with N1 [seekerAuctionRecovery] → the round view is refreshed BEFORE SENT is published.
 * Nothing re-prompts: an uncertain step keeps its attempt and is only observed. Logged decisions: a second bid on the same
 * spot is admitted only above every unresolved bid there (the program tops escrow up to the highest landed total, so
 * exposure never exceeds the latest approval); a second withdrawal only once the chain has not seen the first (a withdrawal
 * can only return the player's own escrow once). A saved bid is released once a finalized view shows the program can no
 * longer take it (window over, spot settled, or escrow already at its total); a saved withdrawal once nothing is refundable.
 * Observation cadence and bound reuse LAND_CHECKOUT_RECOVERY (pollMs, walletResponseGraceMs); no auction number is copied.
 */
class SeekerAuctionRepository(
    private val session: AccountSession,
    private val holder: AccountSessionHolder,
    private val port: SeekerAuctionAuthenticatedPort,
    private val journal: SeekerAuctionJournal,
    val pins: SeekerAuctionPins,
    private val cluster: SolanaCluster,
    private val policy: () -> SeekerAuctionProtocolPolicy?,
    private val bounds: () -> LandCheckoutBounds?,
    private val verifier: SeekerAuctionVerifier,
    private val payer: WalletPayer?,
    private val rpc: SolanaRpc,
    private val monotonicMs: () -> Long,
    private val walletReady: suspend () -> Boolean = { true },
    private val actionGuard: () -> Unit = {},
    private val report: (WalletFailureReason) -> Unit = ::reportWalletFailure,
) {
    init { require(port.identity.wallet == session.wallet && port.identity.cluster == cluster.id) }
    private val mutable = MutableStateFlow(SeekerAuctionState())
    val state: StateFlow<SeekerAuctionState> = mutable.asStateFlow()
    private val acting = AtomicBoolean(false)

    private class Refused(val notice: SeekerAuctionNotice, val server: String? = null) : Exception(notice.name)

    private fun current() = holder.requireCurrent(session)
    private fun guard() { current(); actionGuard() }
    private fun transport(): SeekerAuctionTransport =
        SeekerAuctionTransport(port, policy() ?: throw Refused(SeekerAuctionNotice.UNAVAILABLE))

    /** Reads the rounds, observes saved attempts (GET only) and resolves them. Skipped while an action owns the journal. */
    suspend fun refresh() {
        current()
        if (acting.get() || !journal.admission.tryLock()) return
        try {
            mutable.update { it.copy(loading = true) }
            reconcile(transport())
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) {
            current(); mutable.update { it.copy(readFailed = true) }
        } finally {
            journal.admission.unlock()
            if (holder.isCurrent(session)) mutable.update { it.copy(loading = false) }
        }
    }

    /** [reviewedIncrementRaw] is the increment the Seal showed (S-D `SeekerBidDraft.incrementRaw`). */
    suspend fun bid(request: SeekerAuctionBidRequest, reviewedIncrementRaw: String) =
        act(SeekerAuctionTarget(SeekerAuctionKind.BID, request.round, request.spot), request.newTotalRaw, reviewedIncrementRaw,
            { t -> t.prepareBid(request, ::guard) }, { prepared -> verifier.bid(prepared, request) })

    suspend fun withdraw(request: SeekerAuctionWithdrawRequest) =
        act(SeekerAuctionTarget(SeekerAuctionKind.WITHDRAW, request.round, request.spot), null, "0",
            { t -> t.prepareWithdrawal(request, ::guard) }, { prepared -> verifier.withdraw(prepared, request) })

    /** The host closed the result; an action in flight keeps its stage. */
    fun dismiss() {
        if (!acting.get()) mutable.update { it.copy(action = null, stage = null, notice = null, noticeText = null) }
    }

    private suspend fun act(target: SeekerAuctionTarget, newTotalRaw: String?, reviewedIncrementRaw: String,
        prepare: suspend (SeekerAuctionTransport) -> SeekerAuctionPrepared, verify: suspend (SeekerAuctionPrepared) -> ByteArray) {
        current()
        if (!acting.compareAndSet(false, true)) return
        var t: SeekerAuctionTransport? = null
        var walletAsked = false
        try {
            mutable.update { it.copy(busy = true, action = target, stage = SeekerAuctionStage.CHECK_WALLET, notice = null, noticeText = null) }
            journal.admission.withLock {
                val wallet = payer
                if (wallet == null || !walletReady()) throw Refused(SeekerAuctionNotice.NO_WALLET)
                guard()
                val b = bounds() ?: throw Refused(SeekerAuctionNotice.UNAVAILABLE)
                val transport = transport().also { t = it }
                admit(target, newTotalRaw, publishPending())
                val prepared = prepare(transport); guard()
                // The Seal showed this increment; the wallet is never asked for more (or less) than the player reviewed.
                if (prepared.incrementRaw != reviewedIncrementRaw) throw Refused(SeekerAuctionNotice.NOT_REVIEWED)
                val unsigned = try { verify(prepared) } catch (_: IllegalArgumentException) { throw Refused(SeekerAuctionNotice.NOT_REVIEWED) }
                guard()
                var attempt = SeekerAuctionAttempt(UUID.randomUUID().toString(), target.kind, target.round, target.spot, newTotalRaw,
                    prepared.blockhash, prepared.lastValidBlockHeight)
                journal.add(attempt); publishPending()
                walletAsked = true
                var walletSent = false
                // Only notes whether the wallet broadcast itself; the payment owner and rail are the shared ones, unchanged.
                val tracking = WalletPayer { tx, net, owner, onSent ->
                    wallet.pay(tx, net, owner) { walletSent = true; onSent(it) }.also { if (it is WalletPayment.Sent) walletSent = true }
                }
                try {
                    ExternalPaymentRail(tracking, rpc, report).pay(unsigned, cluster, session.wallet, guard = ::current,
                        recordSignature = { signature ->
                            if (attempt.signature != signature) {
                                val next = attempt.copy(signature = signature, opaqueSend = walletSent)
                                journal.replace(attempt, next); attempt = next
                            }
                        }, beforeBroadcast = ::guard)
                } catch (refused: WalletPaymentException) {
                    if (!refused.refusedBeforeBroadcast) throw refused
                    // Nobody broadcast anything: the saved step is void, not uncertain.
                    journal.remove(attempt); publishPending(); walletAsked = false
                    throw Refused(SeekerAuctionNotice.NOTHING_SENT)
                }
                current(); publishPending()
                mutable.update { it.copy(stage = SeekerAuctionStage.SENDING) }
                follow(transport, attempt, b)
            }
        } catch (error: CancellationException) { throw error }
        catch (refused: Refused) {
            settle(target, SeekerAuctionStage.FAILED, refused.notice, refused.server)
        } catch (error: Exception) {
            current()
            val refusal = (error as? ApiException)?.let { SeekerAuctionRefusal.from(it.status, it.code) }
            when {
                walletAsked -> settle(target, SeekerAuctionStage.SENDING, SeekerAuctionNotice.CHECKING)
                refusal?.kind == SeekerAuctionRefusalKind.REFRESH_REQUIRED -> {
                    settle(target, SeekerAuctionStage.FAILED, SeekerAuctionNotice.REFRESH_REQUIRED, error.message)
                    t?.let { transport -> runCatching { readViews(transport) }.onFailure { if (it is CancellationException) throw it } }
                }
                else -> settle(target, SeekerAuctionStage.FAILED, SeekerAuctionNotice.UNAVAILABLE)
            }
        } finally {
            acting.set(false)
            if (holder.isCurrent(session)) {
                mutable.update { it.copy(busy = false) }
                runCatching { publishPending() }
            }
        }
    }

    /** Refuses only what could not help: a bid not above an unresolved bid on the same spot, or a second withdrawal while
     * the chain has seen (or may still show) the first. */
    private fun admit(target: SeekerAuctionTarget, newTotalRaw: String?, saved: List<SeekerAuctionAttempt>) {
        val here = saved.filter { it.round == target.round && it.spot == target.spot && it.kind == target.kind }
        val waiting = when (target.kind) {
            SeekerAuctionKind.BID -> here.any { BigInteger(requireNotNull(it.newTotalRaw)) >= BigInteger(requireNotNull(newTotalRaw)) }
            SeekerAuctionKind.WITHDRAW -> here.any { it.signature != null && it.lastFound != false }
        }
        if (waiting) throw Refused(SeekerAuctionNotice.CHECKING)
    }

    /** After the wallet: one signature submission, then GET observation until finality, failure, provable expiry, or the
     * wallet grace bound (then the attempt stays saved and [refresh] keeps observing it). */
    private suspend fun follow(t: SeekerAuctionTransport, signed: SeekerAuctionAttempt, b: LandCheckoutBounds) {
        val signature = requireNotNull(signed.signature)
        val deadline = monotonicMs() + b.walletResponseGraceMs
        var status = t.submit(SeekerAuctionSubmission.ObserveSignature(signature), ::current)
        current()
        var recovery = seekerAuctionRecovery(evidence(signed), status)
        var attempt = remember(signed, status.found)
        while (recovery.phase == SeekerAuctionRecoveryPhase.PENDING && monotonicMs() < deadline) {
            delay(b.pollMs)
            status = t.status(signature, ::current)
            current()
            recovery = seekerAuctionRecovery(evidence(attempt), status, recovery)
            attempt = remember(attempt, status.found)
        }
        resolve(t, attempt, recovery.phase, inAction = true)
    }

    private suspend fun resolve(t: SeekerAuctionTransport, attempt: SeekerAuctionAttempt, phase: SeekerAuctionRecoveryPhase, inAction: Boolean) {
        val target = SeekerAuctionTarget(attempt.kind, attempt.round, attempt.spot)
        // A terminal failure is already known; its round read only refreshes what is shown.
        suspend fun bestEffortRead() {
            if (inAction) try { readViews(t) } catch (error: CancellationException) { throw error } catch (_: Exception) { }
        }
        when (phase) {
            SeekerAuctionRecoveryPhase.FINALIZED -> {
                // Hydrate the round before publishing the accepted result; on failure the attempt stays for the next read.
                if (inAction) readViews(t)
                journal.remove(attempt); settle(target, SeekerAuctionStage.SENT, null)
            }
            SeekerAuctionRecoveryPhase.FAILED -> {
                journal.remove(attempt); bestEffortRead()
                settle(target, SeekerAuctionStage.FAILED, SeekerAuctionNotice.CHAIN_FAILED)
            }
            SeekerAuctionRecoveryPhase.EXPIRED -> {
                journal.remove(attempt); bestEffortRead()
                settle(target, SeekerAuctionStage.FAILED, SeekerAuctionNotice.NOT_LANDED)
            }
            SeekerAuctionRecoveryPhase.PENDING -> if (inAction) settle(target, SeekerAuctionStage.SENDING, SeekerAuctionNotice.CHECKING)
        }
        publishPending()
    }

    /** Observe every signed attempt once, read the rounds, then resolve: finality only after the rounds were read. */
    private suspend fun reconcile(t: SeekerAuctionTransport) {
        val saved = try { journal.read() } catch (_: Exception) { mutable.update { it.copy(journalUnreadable = true) }; null }
        val phases = HashMap<String, SeekerAuctionRecoveryPhase>()
        saved?.filter { it.signature != null }?.forEach { attempt ->
            val status = try { t.status(requireNotNull(attempt.signature), ::current) }
                catch (error: CancellationException) { throw error } catch (_: Exception) { null }
            if (status != null) {
                phases[attempt.intentId] = seekerAuctionRecovery(evidence(attempt), status).phase
                remember(attempt, status.found)
            }
        }
        val views = readViews(t)
        if (saved == null) return
        for (attempt in journal.read()) {
            val phase = phases[attempt.intentId]
            when {
                phase != null && phase != SeekerAuctionRecoveryPhase.PENDING -> resolve(t, attempt, phase, inAction = false)
                moot(attempt, views) -> {
                    journal.remove(attempt)
                    val target = SeekerAuctionTarget(attempt.kind, attempt.round, attempt.spot)
                    mutable.update { if (it.action == target && it.stage == SeekerAuctionStage.SENDING)
                        it.copy(action = null, stage = null, notice = null, noticeText = null) else it }
                }
            }
        }
        publishPending()
    }

    /** True when a finalized read proves the saved step can no longer move SKR: a bid after its window, on a settled spot,
     * or with this wallet's escrow already at its total; a withdrawal once nothing is refundable there. */
    private fun moot(attempt: SeekerAuctionAttempt, views: List<SeekerAuctionSourcedRoundView>): Boolean {
        val view = views.firstOrNull { it.round == attempt.round && it.source == "chain" } ?: return false
        val row = view.spots.firstOrNull { it.spot == attempt.spot } ?: return false
        return when (attempt.kind) {
            SeekerAuctionKind.BID -> view.chainUnixTime.toLong() >= view.auctionEnd.toLong() || row.settled ||
                BigInteger(row.yourBidRaw) >= BigInteger(requireNotNull(attempt.newTotalRaw))
            SeekerAuctionKind.WITHDRAW -> !row.refundable
        }
    }

    /** The current round and, after round 0, the one before it. A failed previous read keeps a previous view of that round. */
    private suspend fun readViews(t: SeekerAuctionTransport): List<SeekerAuctionSourcedRoundView> {
        val now = t.current(::current).also(::pinned)
        current()
        val before = BigInteger(now.round).takeIf { it.signum() > 0 }?.subtract(BigInteger.ONE)?.toString()
        val previous = before?.let { round ->
            try { t.round(round, ::current).also(::pinned) } catch (error: CancellationException) { throw error } catch (_: Exception) { null }
        }
        current()
        val at = monotonicMs()
        mutable.update { it.copy(current = now, previous = previous ?: it.previous?.takeIf { old -> old.round == before },
            readAtMs = at, readFailed = false) }
        return listOfNotNull(now, previous)
    }

    private fun pinned(view: SeekerAuctionSourcedRoundView) {
        check(view.config.programId == pins.programId && view.config.mint == pins.mint && view.config.decimals == pins.decimals) {
            "This auction is not the build's pinned deployment."
        }
    }

    private fun evidence(attempt: SeekerAuctionAttempt) = SeekerAuctionSignedAttempt(requireNotNull(attempt.signature),
        attempt.preparedBlockhash, if (attempt.opaqueSend) null else attempt.preparedBlockhash, attempt.lastValidBlockHeight, attempt.opaqueSend)

    private fun remember(attempt: SeekerAuctionAttempt, found: Boolean?): SeekerAuctionAttempt {
        if (found == null || found == attempt.lastFound) return attempt
        return attempt.copy(lastFound = found).also { journal.replace(attempt, it) }
    }

    private fun publishPending(): List<SeekerAuctionAttempt> {
        val saved = try { journal.read() } catch (_: Exception) {
            mutable.update { it.copy(journalUnreadable = true) }; throw Refused(SeekerAuctionNotice.UNAVAILABLE)
        }
        mutable.update { it.copy(pending = saved, journalUnreadable = false) }
        return saved
    }

    private fun settle(target: SeekerAuctionTarget, stage: SeekerAuctionStage, notice: SeekerAuctionNotice?, server: String? = null) {
        // Only the action the player is looking at changes; an older step resolving elsewhere shows through the round view.
        mutable.update {
            if (it.action != target) it
            else it.copy(stage = stage, notice = notice, noticeText = notice?.let { n -> seekerAuctionNoticeText(n, server) })
        }
    }
}
