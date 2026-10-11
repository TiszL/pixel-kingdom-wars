package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.mobilewalletadapter.clientlib.protocol.JsonRpc20Client
import com.solana.mobilewalletadapter.common.ProtocolContract
import java.io.IOException
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeoutException
import kotlinx.coroutines.TimeoutCancellationException

/** Where one wallet payment stood when it failed. The stage, not the exception class, decides whether anything
 * could have been broadcast: clientlib-ktx 2.0.7 hands every wallet JSON-RPC error to the app wrapped in an
 * [ExecutionException], and an association timeout looks the same before and after the send call.
 * [token] is the stage's name in the on-screen bracket token (`[send:-3]`). */
enum class WalletPayStage(val token: String) {
    /** Association and `authorize`: the payment block has not started. */
    AUTHORIZE("authorize"),
    /** The authorized account is compared with the game wallet, strictly before any signing call. */
    ACCOUNT_CHECK("account"),
    /** `sign_and_send_transactions` is in flight or returned: the wallet may have broadcast. */
    SEND("send"),
    /** `sign_transactions` in the same session, reached only after the send answered -32601 or -2. It never broadcasts. */
    SIGN("sign"),
    /** This app's semantic check of the signed reply; nothing was relayed yet. */
    VALIDATE("validate"),
    /** This app's single relay `sendTransaction` of a signed-only transaction. */
    RELAY("relay"),
}

/** Why a wallet step failed, in a closed vocabulary the payment notice and the native diagnostics channel
 * share: the MWA error code or the failing step, never the transaction, the wallet's own text or the
 * account. [diagnostic] is the code the app's telemetry records (one `NativeError` per entry) and the API's
 * `NATIVE_ERROR_MESSAGES` attributes; [notice] is the one plain sentence of the player's notice — the numeric
 * code and the stage travel in [WalletFailureReason.token], not here. */
enum class WalletFailureKind(val diagnostic: String, val notice: String) {
    ACCOUNT_MISMATCH("NATIVE_WALLET_ACCOUNT_MISMATCH", "the wallet approved a different account from the one you play with"),
    AUTHORIZATION_FAILED("NATIVE_WALLET_AUTHORIZATION_FAILED", "the wallet no longer accepts this app's saved authorization, so the next tap asks it again"),
    INVALID_PAYLOADS("NATIVE_WALLET_INVALID_PAYLOADS", "the wallet rejected the transaction before signing it"),
    NOT_SIGNED("NATIVE_WALLET_NOT_SIGNED", "the request was declined in the wallet"),
    NOT_SUBMITTED("NATIVE_WALLET_NOT_SUBMITTED", "the wallet signed but reported that it did not send"),
    // The game runs on devnet (WalletLogin authorizes `solana:devnet`); Phantom and Solflare refuse that chain
    // until their Devnet/Testnet mode is on. A mainnet build must reword this hint.
    CLUSTER_NOT_SUPPORTED("NATIVE_WALLET_CLUSTER_NOT_SUPPORTED", "the wallet does not support this network — enable Devnet/Testnet mode in the wallet, then retry"),
    METHOD_NOT_FOUND_SEND("NATIVE_WALLET_METHOD_NOT_FOUND_SEND", "the wallet does not offer its own sign-and-send"),
    METHOD_NOT_FOUND_SIGN("NATIVE_WALLET_METHOD_NOT_FOUND_SIGN", "the wallet does not offer transaction signing without sending"),
    REMOTE_ERROR("NATIVE_WALLET_REMOTE_ERROR", "the wallet returned an error"),
    NOT_FOUND("NATIVE_WALLET_NOT_FOUND", "no compatible Solana wallet app answered"),
    TIMEOUT("NATIVE_WALLET_TIMEOUT", "the wallet did not answer in time"),
    INTERRUPTED("NATIVE_WALLET_INTERRUPTED", "the wallet session was cancelled or interrupted"),
    INVALID_RESPONSE("NATIVE_WALLET_INVALID_RESPONSE", "the wallet's reply failed this app's checks"),
    TX_VERSION_CHANGED("NATIVE_WALLET_TX_VERSION_CHANGED", "the wallet returned a different transaction version"),
    TX_SIGNERS_CHANGED("NATIVE_WALLET_TX_SIGNERS_CHANGED", "the wallet changed the fee payer or the required signers"),
    TX_BLOCKHASH_CHANGED("NATIVE_WALLET_TX_BLOCKHASH_CHANGED", "the wallet changed the transaction's expiry"),
    TX_INSTRUCTIONS_CHANGED("NATIVE_WALLET_TX_INSTRUCTIONS_CHANGED", "the wallet changed the reviewed payment instructions"),
    TX_PRIORITY_FEE_TOO_HIGH("NATIVE_WALLET_TX_PRIORITY_FEE_TOO_HIGH", "the wallet added a priority fee above this app's safety limit"),
    TX_BAD_SIGNATURE("NATIVE_WALLET_TX_BAD_SIGNATURE", "the wallet's signature does not match the transaction it returned"),
    RPC_REJECTED("NATIVE_WALLET_RPC_REJECTED", "the network relay rejected the signed transaction"),
    /** Not failures: a payment that SUCCEEDED through the sign-only fallback, so diagnostics show which path works. */
    FALLBACK_USED("NATIVE_WALLET_FALLBACK_USED", "paid by signing in the wallet and relaying through the game"),
    FALLBACK_USED_COMPUTE_BUDGET("NATIVE_WALLET_FALLBACK_USED_COMPUTE_BUDGET", "paid by signing in the wallet, which added its priority fee, and relaying through the game"),
    UNKNOWN("NATIVE_WALLET_UNKNOWN", "unclassified wallet failure"),
}

/** A classified wallet failure: the [kind], the numeric JSON-RPC [code] whenever the wallet or the relay gave
 * one, the [stage] it happened in, and — when it ended the sign-only fallback — the send refusal it came [after]. */
data class WalletFailureReason(val kind: WalletFailureKind, val code: Long? = null, val stage: WalletPayStage? = null,
                               val after: WalletFailureReason? = null) {
    private val step: String get() = listOfNotNull(stage?.token, code?.toString() ?: kind.name).joinToString(":")
    /** `[send:-3]`, `[authorize:-7]`, `[send:-32601 > validate:TX_INSTRUCTIONS_CHANGED]`: what support reads off a
     * screenshot, because release builds strip device logs. Codes and closed names only. */
    val token: String get() = "[" + listOfNotNull(after?.step, step).joinToString(" > ") + "]"
    /** One plain sentence plus the [token]; never the wallet's own text. */
    val notice: String get() = "${kind.notice} $token"
    /** Every reason of this payment in the order it happened, for one diagnostics record each. */
    val chain: List<WalletFailureReason> get() = listOfNotNull(after, copy(after = null))
}

/** clientlib-ktx 2.0.7 delivers a wallet's JSON-RPC error as the future's [ExecutionException]; the verdict
 * must be read from what it wraps. */
internal fun unwrapWalletCause(cause: Throwable?): Throwable? {
    var current = cause
    while (current is ExecutionException && current.cause != null) current = current.cause
    return current
}

/** JSON-RPC 2.0 reserved code the MWA spec assigns to an unimplemented method. */
const val JSON_RPC_METHOD_NOT_FOUND = -32601

/** Maps the throwable a wallet step surfaced to the closed vocabulary. Only the class, the JSON-RPC code and
 * the [stage] are read; no message travels, so a provider's or wallet's free text can never reach a notice or a report. */
fun walletFailureReason(cause: Throwable?, stage: WalletPayStage? = null): WalletFailureReason {
    fun reason(kind: WalletFailureKind, code: Long? = null) = WalletFailureReason(kind, code, stage)
    return when (val unwrapped = unwrapWalletCause(cause)) {
        null -> reason(WalletFailureKind.UNKNOWN)
        is WalletRefusedException -> reason(unwrapped.kind)
        is SignedTransactionRejected -> reason(unwrapped.kind)
        is WalletPaymentException -> unwrapped.reason ?: reason(WalletFailureKind.UNKNOWN)
        // InvalidPayloadsException / NotSubmittedException are remote exceptions carrying these codes.
        is JsonRpc20Client.JsonRpc20RemoteException -> reason(when (unwrapped.code) {
            ProtocolContract.ERROR_AUTHORIZATION_FAILED -> WalletFailureKind.AUTHORIZATION_FAILED
            ProtocolContract.ERROR_INVALID_PAYLOADS -> WalletFailureKind.INVALID_PAYLOADS
            ProtocolContract.ERROR_NOT_SIGNED -> WalletFailureKind.NOT_SIGNED
            ProtocolContract.ERROR_NOT_SUBMITTED -> WalletFailureKind.NOT_SUBMITTED
            ProtocolContract.ERROR_CLUSTER_NOT_SUPPORTED -> WalletFailureKind.CLUSTER_NOT_SUPPORTED
            JSON_RPC_METHOD_NOT_FOUND -> when (stage) {
                WalletPayStage.SEND -> WalletFailureKind.METHOD_NOT_FOUND_SEND
                WalletPayStage.SIGN -> WalletFailureKind.METHOD_NOT_FOUND_SIGN
                else -> WalletFailureKind.REMOTE_ERROR
            }
            else -> WalletFailureKind.REMOTE_ERROR
        }, unwrapped.code.toLong())
        is JsonRpc20Client.JsonRpc20Exception -> reason(WalletFailureKind.INVALID_RESPONSE)
        is SolanaRpcException -> reason(WalletFailureKind.RPC_REJECTED, unwrapped.code)
        is TimeoutCancellationException, is TimeoutException -> reason(WalletFailureKind.TIMEOUT)
        is CancellationException, is InterruptedException, is IOException -> reason(WalletFailureKind.INTERRUPTED)
        is IllegalArgumentException, is IllegalStateException -> reason(WalletFailureKind.INVALID_RESPONSE)
        else -> reason(WalletFailureKind.UNKNOWN)
    }
}

/** The money verdict of one failed wallet payment, by the [stage] it reached and the UNWRAPPED wallet code.
 * True means nothing can have been broadcast, so the purchase is re-payable; false means the wallet's own send
 * (or this app's relay) may have reached the network and only the server's reference scan may decide.
 *  - before the send call (association, `authorize`, the account check) nothing was handed to a signer;
 *  - the send itself refused only by an explicit wallet answer: -1 authorization, -2 invalid payload, -3 declined,
 *    -32601 no such method. -4 (signed, "not submitted"), a timeout, I/O, a cancellation, a failed shape check of
 *    the reply or any other code can follow a broadcast;
 *  - `sign_transactions` never broadcasts and this app has not relayed yet, whatever failed there. */
internal fun refusedBeforeBroadcast(stage: WalletPayStage, cause: Throwable?): Boolean = when (stage) {
    WalletPayStage.AUTHORIZE, WalletPayStage.ACCOUNT_CHECK, WalletPayStage.SIGN, WalletPayStage.VALIDATE -> true
    WalletPayStage.SEND -> (unwrapWalletCause(cause) as? JsonRpc20Client.JsonRpc20RemoteException)?.code in SEND_REFUSED_CODES
    WalletPayStage.RELAY -> false
}
private val SEND_REFUSED_CODES = setOf(ProtocolContract.ERROR_AUTHORIZATION_FAILED, ProtocolContract.ERROR_INVALID_PAYLOADS,
    ProtocolContract.ERROR_NOT_SIGNED, JSON_RPC_METHOD_NOT_FOUND)

/** A send answer after which the same session may sign only: the wallet executed nothing (-32601) or rejected
 * the send payload before signing (-2). A decline (-3), a refused authorization (-1) or anything uncertain never
 * leads to a second prompt. */
internal fun permitsSignOnlyFallback(cause: Throwable?): Boolean =
    (unwrapWalletCause(cause) as? JsonRpc20Client.JsonRpc20RemoteException)?.code.let { it == JSON_RPC_METHOD_NOT_FOUND || it == ProtocolContract.ERROR_INVALID_PAYLOADS }

/** The MWA adapter instance is the pairing with one wallet app: the ktx adapter privately caches the paired
 * wallet's endpoint after the first authorization, and only a deauthorize round trip through that same wallet
 * would clear it. Forgetting the wallet therefore replaces the instance, which also drops its in-memory token,
 * so the next association is a plain `solana-wallet:` intent again. Whether Android then shows a chooser is
 * Android's call (two or more wallets installed, none set as default); this library cannot target a package. */
internal class WalletPairing<A : Any>(private val create: () -> A) {
    @Volatile var adapter: A = create(); private set
    fun forget() { adapter = create() }
}
