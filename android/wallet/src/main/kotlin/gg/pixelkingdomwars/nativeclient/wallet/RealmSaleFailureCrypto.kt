package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import gg.pixelkingdomwars.nativeclient.realmsales.*
import java.util.Base64
import java.util.Collections

/** Historical application pins, supplied independently of the failure response.
 * Keep the original policy/deployment available after current catalogue changes. */
data class RealmSaleFailureTrust(val signing: RealmSaleSigningTrust, val upgradeAuthority: String?)
/** Exact signed intent bound to an owner's failed-execution attestation. This
 * proves neither independent chain finality nor permission to replace or clear. */
class BoundRealmSaleFailure internal constructor(val failure: RealmSaleFailure) {
    val nativeFinalityVerified = false
    val currentSigningAuthorized = false
    val broadcastAuthorized = false
    val journalClearingAuthorized = false
}
object RealmSaleFailureCrypto {
    suspend fun bind(preparation: RealmSalePreparation, wire: RealmSaleSignedWire, failure: RealmSaleFailure,
        trust: RealmSaleFailureTrust, policy: RealmSaleSigningPolicy): BoundRealmSaleFailure {
        // Own every mutable collection and all caller-provided pins before any PDA suspension.
        val rules = policy.copy(protocol = policy.protocol.copy())
        val p = ownRealmSalePreparation(preparation, rules); val w = wire.copy()
        require(failure.receipt.source.accounts.size == 3)
        val f = failure.copy(receipt = failure.receipt.copy(source = failure.receipt.source.copy(
            accounts = Collections.unmodifiableList(ArrayList(failure.receipt.source.accounts)))))
        val pins = trust.copy(signing = trust.signing.copy()); f.validate(p, w, rules.protocol)
        pins.upgradeAuthority?.let(::realmSaleKey)
        require(f.receipt.source.upgradeAuthority == pins.upgradeAuthority) { "Failure upgrade authority differs from historical application pins" }
        val program = realmSaleKey(p.source.programId)
        val loader = "BPFLoaderUpgradeab1e11111111111111111111111"
        val programData = ProgramDerivedAddress.find(listOf(program), SolanaPublicKey(realmSaleKey(loader))).getOrThrow().bytes
        val expected = listOf(program, programData, realmSaleKey("SysvarC1ock11111111111111111111111111111111"))
        f.receipt.source.accounts.forEachIndexed { index, account ->
            require(realmSaleKey(account.address).contentEquals(expected[index])) { "Failure account differs from reviewed program-data/Clock roster" }
        }
        require(f.receipt.source.accounts[1].dataSha256 == pins.signing.reviewedProgramDataSha256)
        val prepared = RealmSaleTransaction.prepare(p, rules, pins.signing)
        val bytes = realmSaleHex(w.signedTransactionHex, 66, 1232)
        val checked = prepared.verifySignedBase64(Base64.getEncoder().encodeToString(bytes))
        require(checked.signature == w.signature && realmSaleHash(bytes) == w.wireSha256) { "Failed realm-sale original signature or digest differs" }
        return BoundRealmSaleFailure(f)
    }
}
