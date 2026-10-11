package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.MiningClaimPreparationView
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimsProtocolPolicy
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import java.util.Base64

private fun MiningClaimPreparationView.signingInput(): MiningClaimSigningInput {
    require((format!=null||transactions.size == 1) && proof.size <= 16) { "Split mining claims are unsupported" }
    require(format!=null||transactions.single().lookupTables.isEmpty()) { "Mining lookup tables are unsupported" }
    return MiningClaimSigningInput(wallet,
        MiningClaimSigningTrust(identity.genesisHash, identity.programId, identity.configAddress, identity.keepMint, identity.reserveOwner),
        rootSequence, leaf.wallet, leaf.rootSequence, leaf.cumulativeKeepBaseUnits, leaf.cumulativeRenown, leaf.cumulativeDays,
        proof.map { MiningClaimProofNode(it.hash, it.sumBaseUnits, it.isLeft) }, needsAta, needsMinerRecords,
        transactions.map { MiningClaimSigningMessage(it.ordinal, it.kind, it.version, it.message, it.lookupTables.map { table -> table.address }, it.feePayer, it.blockhash) },
        format?.let{f->MiningClaimOrderedFormat(f.lookupTable.address,f.lookupTable.owner,f.lookupTable.executable,f.lookupTable.dataHex,f.lookupTable.slot,f.expectedLookupTable.address,f.expectedLookupTable.dataSha256,f.blockhashContextSlot)})
}

/** Only independently injected application pins may grant an opaque wallet-approval plan. */
suspend fun prepareMiningClaimsSigning(preparation: MiningClaimPreparationView, policy: MiningClaimsProtocolPolicy,
    independentTrust: MiningClaimSigningTrust, ordinal: Int = 0): PreparedMiningClaim {
    preparation.validate(policy)
    return MiningClaimTransaction.prepare(preparation.signingInput(), independentTrust, ordinal, policy.orderedComputeUnitLimit)
}

private fun miningWireBase64(value: String, maximum: Int, minimum: Int): ByteArray {
    require(value.length in 4..((maximum + 2) / 3 * 4) && value.length % 4 == 0) { "Invalid mining wire size" }
    return Base64.getDecoder().decode(value).also {
        require(it.size in minimum..maximum && Base64.getEncoder().encodeToString(it) == value) { "Invalid mining wire encoding" }
    }
}

/** Bounds every legacy collection before the generic signature parser allocates from its counts.
 * These are the admitted mining ABI/packet limits, not game balance constants. */
private fun boundedMiningMessage(message: ByteArray, wallet: String, blockhash: String) {
    var offset = 0
    fun byte(): Int { require(offset < message.size) { "Truncated mining message" }; return message[offset++].toInt() and 255 }
    fun compact(): Int {
        var value = 0
        for (i in 0..2) {
            val b = byte(); require(i < 2 || b <= 3) { "Invalid mining compact length" }
            value = value or ((b and 127) shl (i * 7))
            if (b < 128) { require(i == 0 || b != 0) { "Noncanonical mining compact length" }; return value }
        }
        error("Invalid mining compact length")
    }
    fun take(size: Int): ByteArray { require(size <= message.size - offset); return message.copyOfRange(offset, offset + size).also { offset += size } }
    require(byte() == 1 && byte() == 0) { "Invalid mining signer privileges" }
    val readonly = byte(); val accounts = compact(); require(accounts in 1..16 && readonly < accounts)
    require(base58(take(32)) == wallet) { "Mining payer changed" }
    require((accounts - 1) * 32 <= message.size - offset); offset += (accounts - 1) * 32
    require(base58(take(32)) == blockhash) { "Mining blockhash changed" }
    val instructions = compact(); require(instructions in 1..3) { "Invalid mining instruction count" }
    repeat(instructions) {
        require(byte() < accounts)
        val keys = compact(); require(keys <= 9); repeat(keys) { require(byte() < accounts) }
        val size = compact(); require(size <= 700 && size <= message.size - offset); offset += size
    }
    require(offset == message.size) { "Trailing mining message bytes" }
}

/** Synchronous historical evidence integrity for encrypted journal reads/callbacks. No PDA derivation,
 * current trust, admission token, RPC or coroutine bridge: the store validates the enclosing quote policy.
 * Before a NEW signature, prepareMiningClaimsSigning separately verifies the canonical mining ABI. */
fun verifyMiningClaimSavedWire(preparation: MiningClaimPreparationView, wire: String, ordinal: Int = 0): MiningClaimSavedWire {
    if(preparation.format!=null){val tx=preparation.transactions[ordinal];tx.validate();val checked=verifyOrderedMiningClaimWire(preparation.wallet,tx.blockhash,tx.message,wire,ordinal);return MiningClaimSavedWire(checked.ordinal,checked.wire,checked.signature)}
    require(preparation.transactions.size == 1) { "Split mining claims are unsupported" }
    val tx = preparation.transactions.single()
    tx.validate()
    require(tx.ordinal == 0 && tx.feePayer == preparation.wallet && tx.kind == if (preparation.needsAta || preparation.needsMinerRecords) "combined" else "claim")
    val message = miningWireBase64(tx.message, 1167, 1)
    boundedMiningMessage(message, preparation.wallet, tx.blockhash)
    val signed = miningWireBase64(wire, 1232, 66)
    require(signed.size == message.size + 65 && signed[0] == 1.toByte()) { "Invalid mining signature envelope" }
    val original = byteArrayOf(1) + ByteArray(64) + message
    val signature = paymentTransactionSignature(original, signed, preparation.wallet)
    val checked = semanticPaymentSignature(original, signed, preparation.wallet)
    require(checked.mutation == TransactionMutation.NONE && signature.contentEquals(checked.signature))
    return MiningClaimSavedWire(0, wire, base58(signature))
}

/** AppGraph binds this solely to WalletLogin.signTransactionOnlyWithEvidence and the captured session. */
fun interface MiningClaimsExternalSigner {
    suspend fun sign(prepared: PreparedMiningClaim, cluster: SolanaCluster,
        onSigned: (SignedMiningClaim) -> Unit, guard: () -> Unit): SignedMiningClaim
}

/** Both wallet tracks approve the same opaque canonical plan; neither has a send/relay port. */
class MiningClaimsWallet(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val origin: String, private val cluster: SolanaCluster, private val isEmbedded: suspend (String) -> Boolean,
    private val social: () -> SocialLogin?, private val external: MiningClaimsExternalSigner?) {
    private val admission = Mutex()
    private val mutableMfa = MutableStateFlow<PrivyMfaRequest?>(null)
    val mfa = mutableMfa.asStateFlow()
    private var activeSocial: SocialLogin? = null
    private var activeGuard: (() -> Unit)? = null

    suspend fun sign(prepared: PreparedMiningClaim, record: (MiningClaimSavedWire) -> Unit,
        requireAdmission: () -> Unit): MiningClaimSavedWire = coroutineScope {
        check(admission.tryLock()) { "Mining wallet approval is already in progress" }
        var prompt: Job? = null
        try {
            val context = currentCoroutineContext()
            fun guard() { context.ensureActive(); holder.requireCurrent(session); requireAdmission() }
            guard(); require(session.origin == origin && session.wallet == prepared.wallet)
            var recorded: MiningClaimSavedWire? = null
            val evidenceLock = Any()
            fun retain(value: SignedMiningClaim): MiningClaimSavedWire = synchronized(evidenceLock) {
                val verified = prepared.verifySignedBase64(value.wire)
                require(value == verified) { "Wallet returned inconsistent mining evidence" }
                val saved = MiningClaimSavedWire(verified.ordinal, verified.wire, verified.signature)
                recorded?.let { check(it == saved) { "Wallet returned conflicting mining evidence" }; return@synchronized it }
                // No current-session guard here: this exact wire belongs to the original journal.
                record(saved); recorded = saved; saved
            }
            val embedded = isEmbedded(session.wallet).also { guard() }
            val login = if (embedded) requireNotNull(social()) { "Reconnect the existing mining wallet" } else null
            activeSocial = login; activeGuard = ::guard
            prompt = login?.let { launch { it.mfa.collect { request -> guard(); mutableMfa.value = request } } }
            val result = if (login != null) {
                val signer = login.securitySigner(session.wallet, session.token, ::guard) as? DurableWalletTransactionSigner
                    ?: error("This wallet cannot retain mining signature evidence")
                guard(); require(signer.address == prepared.wallet) { "The mining wallet changed" }
                val bytes = signer.signTransactionWithEvidence(prepared.unsignedTransaction()) { retain(prepared.verifySigned(it)) }
                retain(prepared.verifySigned(bytes))
            } else {
                val signer = requireNotNull(external) { "A compatible Solana wallet is needed" }
                guard()
                val signed = signer.sign(prepared, cluster, { retain(it) }, ::guard)
                retain(signed)
            }
            guard(); result
        } finally {
            prompt?.cancel(); mutableMfa.value = null; activeSocial = null; activeGuard = null; admission.unlock()
        }
    }

    suspend fun submitMfa(request: PrivyMfaRequest, code: String) {
        currentCoroutineContext().ensureActive(); val guard = requireNotNull(activeGuard); guard()
        val login = requireNotNull(activeSocial)
        check(mutableMfa.value === request && login.mfa.value === request)
        login.submitMfaCode(request, code, guard); guard()
    }
    fun cancelMfa(request: PrivyMfaRequest) {
        holder.requireCurrent(session); val login = activeSocial ?: return
        if (mutableMfa.value === request && login.mfa.value === request) login.cancelMfa()
    }
}
