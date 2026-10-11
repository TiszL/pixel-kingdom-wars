package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.SkrFaucetStatus
import gg.pixelkingdomwars.nativeclient.wallet.KeepDepositPayment
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import gg.pixelkingdomwars.nativeclient.wallet.SolanaRpc
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject

/** Where the faucet's numbers stand: known; not confirmable (the catalogue has no SKR_FAUCET block and the server's
 *  status could not be read or did not name its mint, decimals and grant); or the server's test token is not this
 *  build's pinned one. Only KNOWN lets the faucet act. */
enum class SkrFaucetBoundsCheck { KNOWN, UNCONFIRMED, MISMATCH }

/**
 * The faucet's numbers for one sheet visit: the catalogue's `SKR_FAUCET.devnet` first (the normal source), else
 * (night 2026-10-06, until the pack is re-exported with the block) [SkrFaucetBounds.fromStatus] over one read of the
 * server's status, cross-checked against the build's pinned [pin]. Never a Kotlin default: with neither source the
 * faucet stays unavailable and says why.
 */
class SkrFaucetBoundsSource(private val catalogue: () -> SkrFaucetBounds?, private val pin: SkrIdentity?,
    private val readStatus: suspend () -> JsonObject) {
    @Volatile private var derived: SkrFaucetBounds? = null
    fun current(): SkrFaucetBounds? = catalogue() ?: derived
    suspend fun resolve(): SkrFaucetBoundsCheck {
        if (current() != null) return SkrFaucetBoundsCheck.KNOWN
        val identity = pin ?: return SkrFaucetBoundsCheck.UNCONFIRMED
        val status = try { SkrFaucetStatus.from(readStatus()) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { return SkrFaucetBoundsCheck.UNCONFIRMED }
        if (status.mint == null || status.decimals == null || status.grantRaw == null) return SkrFaucetBoundsCheck.UNCONFIRMED
        derived = SkrFaucetBounds.fromStatus(status, identity) ?: return SkrFaucetBoundsCheck.MISMATCH
        return SkrFaucetBoundsCheck.KNOWN
    }
}

/** A reserved grant of this wallet that still needs the player's signature (sign_required / pending, nothing signed
 *  yet): CLAIM continues it through a fresh prepare instead of reserving another. */
fun skrFaucetNeedsSignature(state: SkrFaucetState): Boolean {
    val status = state.status ?: return false
    val today = status.today ?: return false
    val phase = today.attempt?.phase
    return status.enabled && !state.uncertain && status.reason.known && status.reason.raw in setOf("sign_required", "pending") &&
        today.status.isValue("requested") && phase?.known != false && phase?.raw !in setOf("player_signed", "submitted", "finalized")
}

/** CLAIM can run now: an open faucet the repository admits ([SkrFaucetState.canClaim]), or a reserved grant that only
 *  needs the player's signature. Anything else draws CLAIM off with its reason. (A background read in flight does not
 *  switch it off: [SkrFaucetFlow.claim] waits for that read instead.) */
fun skrFaucetClaimable(state: SkrFaucetState): Boolean = state.canClaim || skrFaucetNeedsSignature(state)

/**
 * The faucet sheet's jobs over one [SkrFaucetRepository], never two at once (one gate, so a background read can never
 * swallow a CLAIM tap through the repository's own try-lock admission):
 *  - [observe]: what the repository's `foreground()` does (re-send a saved signed wire for its still-prepared attempt,
 *    then read the status), repeated at the catalogue's cadence; with no cadence it reads once.
 *  - [claim]: one player tap. From an open faucet it reserves today's grant (POST /claim) and goes straight on to the
 *    wallet step: a fresh server prepare, the player's sign-only approval on the phone, POST /submit. From a reserved
 *    grant that still needs the signature it does only that second half. Then one status read, so the sheet shows the
 *    server's next state. A claim whose reply was lost stops after the reservation: the repository keeps the intent and
 *    finds the grant through GET /devnet-skr-faucet/grants on a later read; nothing is posted twice.
 */
class SkrFaucetFlow(private val repository: SkrFaucetRepository, private val bounds: () -> SkrFaucetBounds?) {
    private val gate = Mutex()
    private val completedReads = MutableStateFlow(0)
    /** Status reads finished this visit (an unanswered faucet reads "…" until the first one). */
    val reads: StateFlow<Int> = completedReads.asStateFlow()

    private suspend fun read() { repository.refresh(); completedReads.update { it + 1 } }

    suspend fun observe() {
        gate.withLock { repository.recover(); completedReads.update { it + 1 } }
        while (true) {
            gate.withLock { read() }
            delay(bounds()?.pollMs ?: return)
        }
    }

    suspend fun refresh() = gate.withLock { read() }

    /** Returns the refusal to show the player, or null. */
    suspend fun claim(): String? = gate.withLock {
        val refusal = if (skrFaucetNeedsSignature(repository.state.value)) {
            repository.prepareAndSign(); repository.state.value.error
        } else {
            repository.claim()
            val reserved = repository.state.value
            if (reserved.error == null && !reserved.uncertain && reserved.grant?.status?.isValue("requested") == true) {
                repository.prepareAndSign(); repository.state.value.error
            } else reserved.error
        }
        read()
        refusal
    }
}

/** The wallet's balance of the pinned TEST SKR mint, in base units, through the session's `/rpc/solana/<cluster>`
 *  relay ([rpc]). The wallet hub's SKR row is the mainnet token, so it never shows the faucet's devnet test SKR. "0"
 *  only when the wallet's token account provably does not exist yet (the first claim creates it). */
suspend fun skrTestBalanceRaw(rpc: SolanaRpc, wallet: String, pin: SkrIdentity): String {
    val account = KeepDepositPayment.sourceAta(wallet, pin.mint)
    if (!rpc.accountExists(account)) return "0"
    return rpc.tokenBalance(account, pin.decimals).toString()
}
