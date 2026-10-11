package gg.pixelkingdomwars.nativeclient.wallet

import android.net.Uri
import androidx.activity.ComponentActivity
import com.solana.mobilewalletadapter.clientlib.*
import gg.pixelkingdomwars.nativeclient.network.*
import java.math.BigInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.*
import kotlinx.serialization.json.JsonObject

/** Only wallet-approved signatures cross into existing server authentication. */
class WalletLogin(activity: ComponentActivity, private val api: GameApi, private val store: SecretStore,
                  identityOrigin: String = WalletIdentity.PRODUCTION) {
    private val authorizationEpoch = AtomicLong()
    private val sender = ActivityResultSender(activity)
    private val connectionIdentity = ConnectionIdentity(
        identityUri = Uri.parse(WalletIdentity.origin(identityOrigin)),
        iconUri = Uri.parse("icons/icon-192.png"), identityName = WalletIdentity.name(identityOrigin)
    )
    private val pairing = WalletPairing { MobileWalletAdapter(connectionIdentity = connectionIdentity).apply { blockchain = Solana.Devnet } }
    private val adapter get() = pairing.adapter

    suspend fun signIn(session: SessionToken? = null, requireCurrentIdentity: () -> Unit = {}): JsonObject {
        val adapter = this.adapter
        val apiSession=session ?: api.beginAuthentication(api.boundSession())
        val challengeLogin=WalletChallengeLogin(api,apiSession)
        val epoch=authorizationEpoch.get()
        val context=currentCoroutineContext()
        fun guard() {
            context.ensureActive()
            api.requireCurrentSession(apiSession)
            if(authorizationEpoch.get()!=epoch) throw CancellationException("Wallet authorization changed during sign-in")
            requireCurrentIdentity()
        }
        // This runs inside GameModel's guarded account action, never during Activity construction.
        // Re-read on every attempt: an unreadable saved token must not become an anonymous wallet
        // request, and a successful clear must remain effective without a separate hydration flag.
        val savedToken=withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.read() } }
        synchronized(authorizationEpoch) { guard(); adapter.authToken=savedToken }
        // The wallet step a failure belongs to: association/authorize until the block runs, the wallet's signing
        // call while it is open, otherwise none (this app's own server round trips keep the generic sentence).
        val walletStage = AtomicReference<WalletPayStage?>(WalletPayStage.AUTHORIZE)
        val result = adapter.transact(sender) { authorization ->
            walletStage.set(null)
            guard()
            val account = authorization.accounts.firstOrNull() ?: error("The wallet did not provide an account")
            val publicKey=account.publicKey.copyOf()
            require(publicKey.size==32) { "The wallet returned an invalid account" }
            // This signer exists only inside the active MWA association.
            val signer=object : WalletSigner {
                override val address=base58(publicKey)
                override suspend fun signMessage(message: ByteArray): ByteArray {
                    val input=message.copyOf()
                    guard()
                    walletStage.set(WalletPayStage.SIGN)
                    val signed=signMessagesDetached(arrayOf(input.copyOf()),arrayOf(publicKey.copyOf()))
                    walletStage.set(null)
                    guard()
                    val reply=requireNotNull(signed.messages.singleOrNull()) { "The wallet returned an invalid signing response" }
                    return checkedDetachedSignature(input,publicKey,reply.message,reply.addresses,reply.signatures)
                }
            }
            challengeLogin.signIn(signer,::guard)
        }
        guard()
        return when (result) {
            is TransactionResult.Success -> {
                adapter.authToken?.let { token -> withContext(Dispatchers.IO) {
                    synchronized(authorizationEpoch) { guard(); store.write(token) }
                } }
                guard()
                requireNotNull(result.successPayload) { "The wallet returned no sign-in response" }
            }
            is TransactionResult.NoWalletFound -> error("Install or enable Seed Vault Wallet or another compatible Solana wallet, then retry.")
            is TransactionResult.Failure -> throw walletSessionFailure("Wallet sign-in", walletStage.get(), result.e)
        }
    }
    /** A failed sign-in or confirmation. MWA -1 means the wallet refuses the saved token: the spec says discard
     * it, so the next tap authorizes afresh instead of failing the same way until USE ANOTHER WALLET is found.
     * A wallet step names its classified reason (for example -7, network not supported) and its bracket token;
     * a failure of this app's own server round trip keeps the generic sentence. Wallet text never travels. */
    private fun walletSessionFailure(action: String, stage: WalletPayStage?, cause: Exception): IllegalStateException {
        val reason = stage?.let { walletFailureReason(cause, it) }
        if (reason != null) forgetRefusedToken(reason)
        return IllegalStateException(sessionFailureNotice(action, reason), cause)
    }
    fun clearAuthorization() = synchronized(authorizationEpoch) {
        authorizationEpoch.incrementAndGet()
        adapter.authToken = null
        store.clear()
    }
    /** Forgets the wallet app this device paired with — the saved authorization token and the adapter's
     * cached wallet endpoint ([WalletPairing]) — so the next association is a fresh `solana-wallet:` intent
     * rather than the last wallet's remembered endpoint. Which app answers that intent is Android's decision:
     * it asks only when two or more wallets are installed and none is the default; clientlib-ktx 2.0.7 has no
     * way to target a package. Sign-out keeps its narrower [clearAuthorization]. */
    fun forgetWallet() = synchronized(authorizationEpoch) {
        authorizationEpoch.incrementAndGet()
        pairing.forget()
        store.clear()
    }
    /** MWA -1 during a payment: the wallet no longer honours the saved token, so keeping it would fail every
     * later tap the same way. Forgetting it makes the next explicit tap re-authorize; no flight is in progress,
     * so the epoch stays and the caller's own guard still decides the current result. */
    private fun forgetRefusedToken(reason: WalletFailureReason) {
        if (reason.kind != WalletFailureKind.AUTHORIZATION_FAILED) return
        synchronized(authorizationEpoch) { adapter.authToken = null; store.clear() }
    }
    /** Fresh proof for a sensitive server action. Signs the exact returned message without broadcasting;
     * it cannot borrow a new account or a new session while the wallet prompt is open. */
    suspend fun signMessage(message: ByteArray, expectedWallet: String, session: SessionToken,
                            requireCurrentIdentity: () -> Unit = {}): ByteArray {
        val adapter = this.adapter
        val input = message.copyOf()
        require(input.isNotEmpty()) { "Missing server challenge" }
        val expectedKey = publicKeyBytes(expectedWallet)
        val epoch = authorizationEpoch.get()
        val context = currentCoroutineContext()
        fun guard() {
            context.ensureActive()
            api.requireCurrentSession(session)
            if (authorizationEpoch.get() != epoch) throw CancellationException("Wallet authorization changed during confirmation")
            requireCurrentIdentity()
        }
        val savedToken = withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.read() } }
        synchronized(authorizationEpoch) { guard(); adapter.authToken = savedToken }
        val walletStage = AtomicReference<WalletPayStage?>(WalletPayStage.AUTHORIZE)
        val result = adapter.transact(sender) { authorization ->
            walletStage.set(WalletPayStage.ACCOUNT_CHECK)
            guard()
            val account = authorization.accounts.firstOrNull() ?: throw WalletRefusedException("The wallet did not provide an account", WalletFailureKind.INVALID_RESPONSE)
            if (!account.publicKey.contentEquals(expectedKey)) throw WalletRefusedException("Confirm with the wallet that owns this account")
            walletStage.set(WalletPayStage.SIGN)
            val signed = signMessagesDetached(arrayOf(input.copyOf()), arrayOf(expectedKey.copyOf()))
            guard()
            val reply = requireNotNull(signed.messages.singleOrNull()) { "The wallet returned an invalid signing response" }
            checkedDetachedSignature(input, expectedKey, reply.message, reply.addresses, reply.signatures)
        }
        guard()
        return when (result) {
            is TransactionResult.Success -> {
                adapter.authToken?.let { token -> withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.write(token) } } }
                guard()
                requireNotNull(result.successPayload) { "The wallet returned no confirmation" }
            }
            is TransactionResult.NoWalletFound -> error("Install or enable Seed Vault Wallet or another compatible Solana wallet, then retry.")
            is TransactionResult.Failure -> throw walletSessionFailure("Wallet confirmation", walletStage.get(), result.e)
        }
    }

    /** Mining uses exact sign-only approval. Full verified wire is saved before any post-wallet guard;
     * this method never calls a wallet send method or relays a transaction. */
    suspend fun signTransactionOnlyWithEvidence(prepared: PreparedMiningClaim, cluster: SolanaCluster,
        session: SessionToken, onSigned: (SignedMiningClaim) -> Unit, requireCurrentIdentity: () -> Unit): SignedMiningClaim {
        val adapter = this.adapter
        val epoch = authorizationEpoch.get()
        val context = currentCoroutineContext()
        fun guard() {
            context.ensureActive(); api.requireCurrentSession(session)
            if (authorizationEpoch.get() != epoch) throw CancellationException("Wallet authorization changed during mining approval")
            requireCurrentIdentity()
        }
        val savedToken = withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.read() } }
        synchronized(authorizationEpoch) { guard(); adapter.authToken = savedToken; adapter.blockchain = cluster.blockchain }
        val result = adapter.transact(sender) { authorization ->
            signMiningClaimInSession(prepared, authorization.accounts.firstOrNull()?.publicKey, ::guard, onSigned)
        }
        guard()
        return when (result) {
            is TransactionResult.Success -> {
                adapter.authToken?.let { token -> withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.write(token) } } }
                guard(); requireNotNull(result.successPayload) { "The wallet returned no mining signature" }
            }
            is TransactionResult.NoWalletFound -> error("Install or enable a compatible Solana wallet, then retry.")
            is TransactionResult.Failure -> throw walletSessionFailure("Mining approval", WalletPayStage.SIGN, result.e)
        }
    }

    /** Realm sales use exact sign-only approval. Full verified wire is saved before any post-wallet guard;
     * this method never calls a wallet send method or relays a transaction. */
    suspend fun signTransactionOnlyWithEvidence(prepared: PreparedRealmSale, cluster: SolanaCluster,
        session: SessionToken, onSigned: suspend (SignedRealmSale) -> Unit, requireCurrentIdentity: () -> Unit): SignedRealmSale {
        val adapter = this.adapter
        val epoch = authorizationEpoch.get()
        val context = currentCoroutineContext()
        fun guard() {
            context.ensureActive(); api.requireCurrentSession(session)
            if (authorizationEpoch.get() != epoch) throw CancellationException("Wallet authorization changed during realm purchase approval")
            requireCurrentIdentity()
        }
        val savedToken = withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.read() } }
        synchronized(authorizationEpoch) { guard(); adapter.authToken = savedToken; adapter.blockchain = cluster.blockchain }
        val result = adapter.transact(sender) { authorization ->
            signRealmSaleInSession(prepared, authorization.accounts.firstOrNull()?.publicKey, ::guard, onSigned)
        }
        guard()
        return when (result) {
            is TransactionResult.Success -> {
                adapter.authToken?.let { token -> withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.write(token) } } }
                guard(); requireNotNull(result.successPayload) { "The wallet returned no realm purchase signature" }
            }
            is TransactionResult.NoWalletFound -> error("Install or enable a compatible Solana wallet, then retry.")
            is TransactionResult.Failure -> throw walletSessionFailure("Realm purchase approval", WalletPayStage.SIGN, result.e)
        }
    }

    /** Charters use exact sign-only approval. Full verified wire is saved before any post-wallet guard;
     * this method never calls a wallet send method or relays a transaction. */
    suspend fun signTransactionOnlyWithEvidence(prepared: PreparedCharter, cluster: SolanaCluster,
        session: SessionToken, onSigned: suspend (SignedCharter) -> Unit, requireCurrentIdentity: () -> Unit): SignedCharter {
        val adapter = this.adapter
        val epoch = authorizationEpoch.get()
        val context = currentCoroutineContext()
        fun guard() {
            context.ensureActive(); api.requireCurrentSession(session)
            if (authorizationEpoch.get() != epoch) throw CancellationException("Wallet authorization changed during Charter approval")
            requireCurrentIdentity()
        }
        val savedToken = withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.read() } }
        synchronized(authorizationEpoch) { guard(); adapter.authToken = savedToken; adapter.blockchain = cluster.blockchain }
        val result = adapter.transact(sender) { authorization ->
            signCharterInSession(prepared, authorization.accounts.firstOrNull()?.publicKey, ::guard, onSigned)
        }
        guard()
        return when (result) {
            is TransactionResult.Success -> {
                adapter.authToken?.let { token -> withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.write(token) } } }
                guard(); requireNotNull(result.successPayload) { "The wallet returned no Charter signature" }
            }
            is TransactionResult.NoWalletFound -> error("Install or enable a compatible Solana wallet, then retry.")
            is TransactionResult.Failure -> throw walletSessionFailure("Charter approval", WalletPayStage.SIGN, result.e)
        }
    }

    /** Vehicle consent is one exact legacy sign-only request. Verified late bytes
     * drain to durable storage before any changed-session or cancelled-view guard. */
    suspend fun signTransactionOnlyWithEvidence(prepared: PreparedVehicle, cluster: SolanaCluster,
        session: SessionToken, onSigned: suspend (kotlinx.serialization.json.JsonObject) -> Unit, beforeWallet:suspend ()->Unit,
        requireCurrentIdentity: () -> Unit): kotlinx.serialization.json.JsonObject {
        val adapter = this.adapter
        val epoch = authorizationEpoch.get()
        val context = currentCoroutineContext()
        fun guard() {
            context.ensureActive(); api.requireCurrentSession(session)
            if (authorizationEpoch.get() != epoch) throw CancellationException("Wallet authorization changed during vehicle approval")
            requireCurrentIdentity()
        }
        val savedToken = withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.read() } }
        synchronized(authorizationEpoch) { guard(); adapter.authToken = savedToken; adapter.blockchain = cluster.blockchain }
        val result = adapter.transact(sender) { authorization ->
            signVehicleInSession(prepared,authorization.accounts.firstOrNull()?.publicKey,::guard,beforeWallet,onSigned)
        }
        guard()
        return when (result) {
            is TransactionResult.Success -> {
                adapter.authToken?.let { token -> withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.write(token) } } }
                guard(); requireNotNull(result.successPayload) { "The wallet returned no vehicle signature" }
            }
            is TransactionResult.NoWalletFound -> error("Install or enable a compatible Solana wallet, then retry.")
            is TransactionResult.Failure -> throw walletSessionFailure("Vehicle approval", WalletPayStage.SIGN, result.e)
        }
    }

    /** KEEP tax claims use exact sign-only approval. Full verified wire is saved before any post-wallet guard;
     * this method never calls a wallet send method or relays a transaction. */
    suspend fun signTransactionOnlyWithEvidence(prepared: PreparedMiningTaxClaims, cluster: SolanaCluster,
        session: SessionToken, onSigned: suspend (SignedMiningTaxClaims) -> Unit, requireCurrentIdentity: () -> Unit): SignedMiningTaxClaims {
        val adapter = this.adapter
        val epoch = authorizationEpoch.get()
        val context = currentCoroutineContext()
        fun guard() {
            context.ensureActive(); api.requireCurrentSession(session)
            if (authorizationEpoch.get() != epoch) throw CancellationException("Wallet authorization changed during KEEP tax claim approval")
            requireCurrentIdentity()
        }
        val savedToken = withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.read() } }
        synchronized(authorizationEpoch) { guard(); adapter.authToken = savedToken; adapter.blockchain = cluster.blockchain }
        val result = adapter.transact(sender) { authorization ->
            signMiningTaxClaimInSession(prepared, authorization.accounts.firstOrNull()?.publicKey, ::guard, onSigned)
        }
        guard()
        return when (result) {
            is TransactionResult.Success -> {
                adapter.authToken?.let { token -> withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.write(token) } } }
                guard(); requireNotNull(result.successPayload) { "The wallet returned no KEEP tax claim signature" }
            }
            is TransactionResult.NoWalletFound -> error("Install or enable a compatible Solana wallet, then retry.")
            is TransactionResult.Failure -> throw walletSessionFailure("KEEP tax claim approval", WalletPayStage.SIGN, result.e)
        }
    }

    /** The devnet test SKR claim uses exact sign-only approval (the faucet co-signs and sends it). Full verified wire is
     * saved before any post-wallet guard; this method never calls a wallet send method or relays a transaction. */
    suspend fun signTransactionOnlyWithEvidence(prepared: PreparedSkrFaucetClaim, cluster: SolanaCluster,
        session: SessionToken, onSigned: suspend (SignedSkrFaucetClaim) -> Unit, requireCurrentIdentity: () -> Unit): SignedSkrFaucetClaim {
        val adapter = this.adapter
        val epoch = authorizationEpoch.get()
        val context = currentCoroutineContext()
        fun guard() {
            context.ensureActive(); api.requireCurrentSession(session)
            if (authorizationEpoch.get() != epoch) throw CancellationException("Wallet authorization changed during test SKR claim approval")
            requireCurrentIdentity()
        }
        val savedToken = withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.read() } }
        synchronized(authorizationEpoch) { guard(); adapter.authToken = savedToken; adapter.blockchain = cluster.blockchain }
        val result = adapter.transact(sender) { authorization ->
            signSkrFaucetClaimInSession(prepared, authorization.accounts.firstOrNull()?.publicKey, ::guard, onSigned)
        }
        guard()
        return when (result) {
            is TransactionResult.Success -> {
                adapter.authToken?.let { token -> withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.write(token) } } }
                guard(); requireNotNull(result.successPayload) { "The wallet returned no test SKR claim signature" }
            }
            is TransactionResult.NoWalletFound -> error("Install or enable a compatible Solana wallet, then retry.")
            is TransactionResult.Failure -> throw walletSessionFailure("Test SKR claim approval", WalletPayStage.SIGN, result.e)
        }
    }

    /** One reviewed payment through ONE Mobile Wallet Adapter association ([payInSession]): the wallet's own
     * `sign_and_send_transactions` first and unconditionally, and only when that answers -32601 or -2 a
     * `sign_transactions` in the same session whose reply is checked semantically ([semanticPaymentSignature]).
     * The game wallet must be the unique required signer of [transaction] and the wallet must approve with that
     * same account. [WalletPayment.Sent] is already broadcast; [WalletPayment.SignedOnly] is for the caller to
     * persist, re-check and relay once. A [WalletPaymentException] says by stage and unwrapped MWA code whether
     * nothing was broadcast (re-payable) or the outcome is uncertain (verify by reference, never re-prompt).
     * [onSent] is the caller's journal: it receives the wallet send's signature inside the association, before this
     * function can end any other way, and a session that fails AFTER that still returns [WalletPayment.Sent]. */
    suspend fun pay(transaction: ByteArray, cluster: SolanaCluster, expectedWallet: String, session: SessionToken,
                    onSent: (ByteArray) -> Unit, requireCurrentIdentity: () -> Unit = {}): WalletPayment =
        payInternal(transaction, cluster, expectedWallet, session, onSent, null, requireCurrentIdentity)

    /** Only callers that validate/save exact signed evidence may opt into the pre-guard callback. */
    suspend fun payWithEvidence(transaction: ByteArray, cluster: SolanaCluster, expectedWallet: String, session: SessionToken,
        onSent: (ByteArray) -> Unit, onSigned: (ByteArray) -> Unit, requireCurrentIdentity: () -> Unit): WalletPayment =
        payInternal(transaction, cluster, expectedWallet, session, onSent, onSigned, requireCurrentIdentity)

    private suspend fun payInternal(transaction: ByteArray, cluster: SolanaCluster, expectedWallet: String, session: SessionToken,
                    onSent: (ByteArray) -> Unit, onSigned: ((ByteArray) -> Unit)?, requireCurrentIdentity: () -> Unit): WalletPayment {
        val adapter = this.adapter
        val input = transaction.copyOf()
        val epoch = authorizationEpoch.get()
        val context = currentCoroutineContext()
        fun guard() {
            context.ensureActive(); api.requireCurrentSession(session)
            if (authorizationEpoch.get() != epoch) throw CancellationException("Wallet authorization changed during payment")
            requireCurrentIdentity()
        }
        try {
            validateTransactionSigner(input, expectedWallet)
            val savedToken = withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.read() } }
            synchronized(authorizationEpoch) { guard(); adapter.authToken = savedToken; adapter.blockchain = cluster.blockchain }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            // This app's own preparation, before any wallet was opened: re-payable, and not a wallet failure.
            guard(); throw WalletPaymentException("The payment could not be prepared for the wallet; nothing was sent.", true, e)
        }
        val flight = WalletPayFlight()
        var escaped: Exception? = null
        val result = try {
            adapter.transact(sender) { authorization -> payInSession(flight, authorization.accounts.firstOrNull()?.publicKey, input, expectedWallet, ::guard, onSent, onSigned) }
        } catch (e: CancellationException) { throw e }
        // ktx turns the failures it knows into a Failure result; a checked exception escaping transact (its own
        // close timeout after the block returned) is judged by the same stage in [walletPaymentOutcome].
        catch (e: Exception) { escaped = e; null }
        guard()
        if (result is TransactionResult.Success) {
            // The wallet may already have broadcast: a token that cannot be saved must not cost the signature.
            adapter.authToken?.let { token ->
                try { withContext(Dispatchers.IO) { synchronized(authorizationEpoch) { guard(); store.write(token) } } }
                catch (e: CancellationException) { throw e } catch (_: Exception) {}
            }
            guard()
        }
        return try { walletPaymentOutcome(flight, result, escaped) }
        catch (e: WalletPaymentException) { e.reason?.let(::forgetRefusedToken); throw e }
    }
}

/** A payment the wallet could not complete. [refusedBeforeBroadcast] is true only for a positive
 * pre-broadcast refusal (declined, invalid, no wallet); anything else may follow a successful
 * broadcast and must be reconciled by the server's reference scan before another signature.
 * [reason] is the closed-vocabulary cause when a wallet step produced one (never wallet text). */
class WalletPaymentException(message: String, val refusedBeforeBroadcast: Boolean, cause: Throwable? = null,
                             val reason: WalletFailureReason? = null) : IllegalStateException(message, cause) {
    /** What the notice says beside the money-honest verdict: the classified reason, else this exception's own fixed copy. */
    val detail: String get() = reason?.notice ?: message ?: "wallet failure"
}

/** An app-side check that ran strictly before the wallet's signing call inside the association: no
 * transaction reached the wallet's signer, so a new signature is safe. Thrown nowhere else. */
class WalletRefusedException(message: String, val kind: WalletFailureKind = WalletFailureKind.ACCOUNT_MISMATCH) : IllegalStateException(message)

/** The two land sentences with the classified reason appended, so the player (and support reading the
 * screen) see which step refused instead of one generic line. Also used by the app's land relay. */
fun landPaymentNotice(refusedBeforeBroadcast: Boolean, reason: WalletFailureReason): String =
    (if (refusedBeforeBroadcast) "Payment cancelled — your land is still reserved. Tap pay when ready."
    else "Wallet response was interrupted — checking your payment before another attempt.") + " (${reason.notice})"

/** Sign-in and confirmation never move money, so their notice is one sentence: the classified wallet reason with
 * its bracket token when a wallet step failed, else the generic line. */
internal fun sessionFailureNotice(action: String, reason: WalletFailureReason?): String =
    if (reason == null) "$action was cancelled or could not complete. Retry when ready."
    else "$action could not complete — ${reason.kind.notice}. Retry when ready. ${reason.token}"

/** Base58 text of raw bytes (wallet addresses, transaction signatures). */
fun base58(bytes: ByteArray): String {
    val alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    var n = BigInteger(1, bytes); val encoded = StringBuilder(); val radix = BigInteger.valueOf(58)
    while (n.signum() > 0) { val result = n.divideAndRemainder(radix); encoded.append(alphabet[result[1].toInt()]); n = result[0] }
    repeat(bytes.takeWhile { it == 0.toByte() }.size) { encoded.append('1') }
    return encoded.reverse().toString()
}
