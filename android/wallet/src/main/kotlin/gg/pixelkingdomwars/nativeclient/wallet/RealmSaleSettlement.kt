package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import gg.pixelkingdomwars.nativeclient.realmsales.*
import java.util.Base64
import java.util.Collections

/** Cryptographic binding of owner-attested historical success. This verifies canonical
 * original consent and receipt bytes, never independent chain finality or fresh admission.
 * Durable journal lifecycle remains a separate controller responsibility. */
object RealmSaleSettlementVerifier {
    private const val loader = "BPFLoaderUpgradeab1e11111111111111111111111"
    private const val clock = "SysvarC1ock11111111111111111111111111111111"
    private const val sysvar = "Sysvar1111111111111111111111111111111111111"
    // Reviewed Anchor ABI discriminator, account size and canonical registry digest.
    private val discriminator = realmSaleHex("96572e0568408b93", 8, 8)
    private val registryHash = realmSaleHex("a4aacd9f6dd5caa33c42b3163d9ad45b0efcb9a500520315792b2b677db9e200", 32, 32)

    suspend fun verify(preparation: RealmSalePreparation, wireMetadata: RealmSaleSignedWire, settlement: RealmSaleSettlement,
        policy: RealmSaleSigningPolicy): RealmSaleSettlement {
        val p = ownRealmSalePreparation(preparation, policy); val w = wireMetadata.copy()
        require(settlement.receipt.accountRentIncreases.size in 1..3 && settlement.receipt.source.accounts.size == 6)
        val s = settlement.copy(receipt = settlement.receipt.copy(
            accountRentIncreases = Collections.unmodifiableList(ArrayList(settlement.receipt.accountRentIncreases)),
            source = settlement.receipt.source.copy(accounts = Collections.unmodifiableList(ArrayList(settlement.receipt.source.accounts)))))
        s.validate(p, w, policy.protocol)
        // All caller-owned inputs are captured and bounded before the first suspend.
        val program = realmSaleKey(p.source.programId); val buyer = realmSaleKey(p.wallet); val b = s.purchase
        val config = realmSalePda(program, "realm_sale_config").bytes
        val access = realmSalePda(program, "realm_access", buyer, byteArrayOf(p.realm.toByte())).bytes
        val saleId = realmSaleHex(p.saleId, 16, 16); val receipt = realmSalePda(program, "realm_sale", buyer, saleId)
        val auctionConfig = realmSalePda(program, "auction_config").bytes
        val term = realmSalePda(program, "seeker_term", auctionConfig, realmSaleLe(p.terms.round)).bytes
        val programData = ProgramDerivedAddress.find(listOf(program), SolanaPublicKey(realmSaleKey(loader))).getOrThrow().bytes
        val expected = listOf(program, programData, config, access, realmSaleKey(clock), receipt.bytes)
        s.receipt.source.accounts.forEachIndexed { i, account ->
            require(realmSaleKey(account.address).contentEquals(expected[i]) && account.owner == (if (i < 2) loader else if (i == 4) sysvar else p.source.programId)
                && account.exists && account.executable == (i == 0)) { "Realm-sale proof account identity changed" }
        }
        realmSaleKey(s.receipt.source.genesisHash); s.receipt.source.upgradeAuthority?.let(::realmSaleKey)
        require(b.address == base58(receipt.bytes))
        val canonical = discriminator + byteArrayOf(policy.protocol.version.toByte()) + config + saleId + buyer + realmSaleKey(b.seller) +
            realmSaleKey(b.developer) + term + byteArrayOf(b.spot.toByte(), b.realm.toByte()) + realmSaleLe(b.day) + realmSaleLe(b.round) +
            realmSaleLe("1", 2) + registryHash + realmSaleLe(b.priceLamports) + realmSaleLe(b.sellerLamports) + realmSaleLe(b.developerLamports) +
            realmSaleLe(b.priorExpiry) + realmSaleLe(b.coverageStart) + realmSaleLe(b.expiresAt) + realmSaleLe(b.acceptedAt) + byteArrayOf(receipt.nonce.toByte())
        val receiptBytes = realmSaleHex(s.receipt.receiptAccountHex, 294, 294)
        require(canonical.size == 294 && canonical.contentEquals(receiptBytes)) { "Realm-sale receipt ABI differs from original purchase" }
        val wire = realmSaleHex(w.signedTransactionHex, 66, 1232)
        val signed = RealmSaleTransaction.verifySigned(p, policy, Base64.getEncoder().encodeToString(wire))
        require(signed.signature == w.signature && realmSaleHash(wire) == w.wireSha256) { "Realm-sale signed evidence changed" }
        require(realmSaleHash(receiptBytes) == s.receipt.source.accounts[5].dataSha256) { "Realm-sale receipt hash changed" }
        return s
    }
}
