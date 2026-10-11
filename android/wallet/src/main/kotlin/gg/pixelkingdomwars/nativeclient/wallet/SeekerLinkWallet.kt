package gg.pixelkingdomwars.nativeclient.wallet

import android.net.Uri
import androidx.activity.ComponentActivity
import com.solana.mobilewalletadapter.clientlib.*
import java.net.URI
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex

/** Purpose-scoped, non-durable message proof. This interface has no login or payment operation. */
fun interface SeekerProofWallet {
    suspend fun prove(challenge: suspend (String) -> ByteArray, guard: () -> Unit): SeekerLinkProof
}
class SeekerLinkProof(val wallet: String, val signature: ByteArray) {
    override fun toString() = "SeekerLinkProof(redacted)"
}

/** Exact canonical auth/message.ts purpose and both identities, before any wallet signs. */
object SeekerLinkContract {
    fun validWallet(value: String) = value.length in 32..44 && runCatching { base58(publicKeyBytes(value)) == value }.getOrDefault(false)
    fun message(origin: String, gameWallet: String, seekerWallet: String, nonce: String, message: String,
        expiresAt: String, ttlMinutes: Long): ByteArray {
        require(validWallet(gameWallet) && validWallet(seekerWallet) && nonce.matches(Regex("[0-9a-f]{48}")))
        val lines = message.split('\n')
        require(lines.size == 8 && lines[7].startsWith("Issued At: ")) { "Unexpected Seeker challenge" }
        val issued = Instant.parse(lines[7].removePrefix("Issued At: "))
        require(Duration.between(issued, Instant.parse(expiresAt)) == Duration.ofMinutes(ttlMinutes)) { "Seeker challenge lifetime changed" }
        val expected = listOf("${URI(origin).authority} wants you to link a Solana Mobile Seeker wallet:", seekerWallet, "",
            "Linking to Pixel Kingdom Wars account: $gameWallet",
            "This proves you control the Seeker wallet. It grants no spending permission, triggers no blockchain transaction, and costs no fees.",
            "", "Nonce: $nonce", lines[7]).joinToString("\n")
        require(message == expected) { "Seeker challenge does not match this account and purpose" }
        return message.toByteArray(Charsets.UTF_8)
    }
}

/** Separate MWA association: never reads/writes the primary authorization or game session.
 * Construct during Activity.onCreate, before registering activity results becomes unavailable. */
class SeekerLinkWallet(activity: ComponentActivity, identityOrigin: String = WalletIdentity.PRODUCTION) : SeekerProofWallet {
    private val admission = Mutex()
    private val sender = ActivityResultSender(activity)
    private val adapter = MobileWalletAdapter(connectionIdentity = ConnectionIdentity(
        identityUri = Uri.parse(WalletIdentity.origin(identityOrigin)), iconUri = Uri.parse("icons/icon-192.png"), identityName = WalletIdentity.name(identityOrigin)
    )).apply { blockchain = Solana.Mainnet }
    override suspend fun prove(challenge: suspend (String) -> ByteArray, guard: () -> Unit): SeekerLinkProof {
        val context = currentCoroutineContext()
        fun current() { context.ensureActive(); guard() }
        current(); check(admission.tryLock()) { "A Seeker wallet confirmation is already open." }
        try {
            adapter.authToken = null
            val result = adapter.transact(sender) { authorization ->
                current()
                val key = requireNotNull(authorization.accounts.firstOrNull()).publicKey.copyOf()
                val wallet = base58(key)
                val input = challenge(wallet).copyOf(); current()
                val signed = signMessagesDetached(arrayOf(input.copyOf()), arrayOf(key.copyOf())); current()
                val reply = requireNotNull(signed.messages.singleOrNull())
                SeekerLinkProof(wallet, checkedDetachedSignature(input, key, reply.message, reply.addresses, reply.signatures))
            }
            current()
            return when (result) {
                is TransactionResult.Success -> requireNotNull(result.successPayload)
                is TransactionResult.NoWalletFound -> error("Install or enable your Seeker wallet to continue.")
                is TransactionResult.Failure -> error("Seeker wallet confirmation was cancelled or interrupted. Your game wallet is unchanged.")
            }
        } finally { adapter.authToken = null; admission.unlock() }
    }
}
