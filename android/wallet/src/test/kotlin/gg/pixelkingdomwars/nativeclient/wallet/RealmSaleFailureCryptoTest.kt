package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.realmsales.*
import java.security.MessageDigest
import java.security.MessageDigestSpi
import java.security.Provider
import java.security.Security
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class RealmSaleFailureCryptoTest {
    private fun resource(path: String) = Json.parseToJsonElement(requireNotNull(javaClass.getResource(path)).readText()).jsonObject
    private val raw get() = resource("/realm-sale-failure.json")
    private val policy get() = resource("/realm-sale-crypto-fixtures.json").getValue("policy").jsonObject.let {
        RealmSaleSigningPolicy(RealmSalesProtocolPolicy.from(JsonObject(it - "kingSpots" - "regularRealmCount")), it.getValue("kingSpots").jsonPrimitive.int, it.getValue("regularRealmCount").jsonPrimitive.int)
    }
    private val p get() = RealmSalePreparation.from(raw.getValue("preparation").jsonObject, policy.protocol)
    private val w get() = RealmSaleSignedWire.from(raw.getValue("wire").jsonObject)
    private val f get() = RealmSaleFailure.from(p, w, raw.getValue("failure").jsonObject, policy.protocol)
    private val trust get() = RealmSaleFailureTrust(RealmSaleSigningTrust(p.source.genesisHash, p.source.programId, p.terms.developer,
        p.source.programDataSha256, p.source.reviewedDeploymentSlot, p.source.revision), f.receipt.source.upgradeAuthority)
    private fun bytes(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun hash(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    private suspend fun bind(p: RealmSalePreparation = this.p, w: RealmSaleSignedWire = this.w, f: RealmSaleFailure = this.f, t: RealmSaleFailureTrust = trust) =
        RealmSaleFailureCrypto.bind(p, w, f, t, policy)
    private suspend fun refuses(block: suspend () -> Unit) { assertTrue("Historical failure evidence must be refused", runCatching { block() }.isFailure) }
    @Test fun `actual public failed wire binds original consent without client finality or clearing authority`() = runBlocking {
        val bound = bind(); assertEquals(f, bound.failure)
        assertFalse(bound.nativeFinalityVerified); assertFalse(bound.currentSigningAuthorized); assertFalse(bound.broadcastAuthorized); assertFalse(bound.journalClearingAuthorized)
    }
    @Test fun `historical uncapped fees null and lagging chain time are retained`() = runBlocking {
        for (time in listOf(null, -1L, f.receipt.blockTime)) {
            val changed = f.copy(receipt = f.receipt.copy(blockTime = time, feeLamports = "18446744073709551615"))
            assertEquals(changed, bind(f = changed).failure)
        }
    }
    @Test fun `every independent historical trust pin including upgrade authority is mandatory`() = runBlocking {
        val t = trust; val s = t.signing; val other = p.terms.seller
        for (wrong in listOf(s.copy(genesisHash = other), s.copy(programId = other), s.copy(developer = other), s.copy(reviewedProgramDataSha256 = "ab".repeat(32)),
            s.copy(reviewedDeploymentSlot = 0), s.copy(revision = "different"))) refuses { bind(t = t.copy(signing = wrong)) }
        refuses { bind(t = t.copy(upgradeAuthority = other)) }; refuses { bind(t = t.copy(upgradeAuthority = null)) }
        refuses { bind(t = t.copy(upgradeAuthority = "11111111111111111111111111111111")) }
        val immutable = f.copy(receipt = f.receipt.copy(source = f.receipt.source.copy(upgradeAuthority = null)))
        assertNull(bind(f = immutable, t = t.copy(upgradeAuthority = null)).failure.receipt.source.upgradeAuthority)
    }
    @Test fun `programdata account is independently derived even when declared grammar is self consistent`() = runBlocking {
        val accounts = f.receipt.source.accounts.toMutableList(); accounts[1] = accounts[1].copy(address = p.terms.seller)
        val changed = f.copy(receipt = f.receipt.copy(source = f.receipt.source.copy(accounts = accounts)))
        changed.validate(p, w, policy.protocol); refuses { bind(f = changed) }
        for (index in listOf(0, 2)) {
            val modified = f.receipt.source.accounts.toMutableList(); modified[index] = modified[index].copy(address = p.terms.seller)
            refuses { bind(f = f.copy(receipt = f.receipt.copy(source = f.receipt.source.copy(accounts = modified)))) }
        }
    }
    @Test fun `forged signature with jointly recomputed metadata cannot replace actual Ed25519`() = runBlocking {
        val packet = bytes(w.signedTransactionHex).also { it[1] = (it[1].toInt() xor 1).toByte() }; val signature = base58(packet.copyOfRange(1, 65)); val digest = hash(packet)
        val wire = w.copy(signedTransactionHex = hex(packet), signature = signature, wireSha256 = digest)
        val failure = f.copy(receipt = f.receipt.copy(signature = signature, signedTransactionSha256 = digest))
        failure.validate(p, wire, policy.protocol); refuses { bind(w = wire, f = failure) }
        val fakeHash = "ab".repeat(32); refuses { bind(w = w.copy(wireSha256 = fakeHash), f = f.copy(receipt = f.receipt.copy(signedTransactionSha256 = fakeHash))) }
        val fakeSignature = base58(ByteArray(64) { 17 }); refuses { bind(w = w.copy(signature = fakeSignature), f = f.copy(receipt = f.receipt.copy(signature = fakeSignature))) }
    }
    @Test fun `self consistent changed message terms roles and packet framing still require canonical original ABI`() = runBlocking {
        val message = bytes(p.quote.messageHex).also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }; val digest = hash(message)
        val prep = p.copy(quote = p.quote.copy(messageHex = hex(message), messageSha256 = digest))
        val packet = bytes(w.signedTransactionHex).copyOfRange(0, 65) + message; val wire = w.copy(signedTransactionHex = hex(packet), messageSha256 = digest, wireSha256 = hash(packet))
        val failure = f.copy(receipt = f.receipt.copy(originalMessageSha256 = digest, signedTransactionSha256 = hash(packet)))
        failure.validate(prep, wire, policy.protocol); refuses { bind(prep, wire, failure) }
        refuses { bind(p = p.copy(terms = p.terms.copy(seller = p.terms.developer))) }
        for (packetHex in listOf("02" + w.signedTransactionHex.drop(2), w.signedTransactionHex + "00", w.signedTransactionHex.uppercase())) refuses { bind(w = w.copy(signedTransactionHex = packetHex)) }
    }
    @Test fun `bounded immutable owned copies preserve complete original evidence`() = runBlocking {
        val rents = p.quote.rents.toMutableList(); val accounts = f.receipt.source.accounts.toMutableList()
        val bound = bind(p.copy(quote = p.quote.copy(rents = rents)), f = f.copy(receipt = f.receipt.copy(source = f.receipt.source.copy(accounts = accounts))))
        rents.clear(); accounts.clear(); assertEquals(f, bound.failure)
        assertThrows(UnsupportedOperationException::class.java) { (bound.failure.receipt.source.accounts as MutableList).clear() }
        val hostile = object : AbstractList<RealmSaleProofAccount>() { override val size = 10000; override fun get(index: Int): RealmSaleProofAccount = error("Must bound before traversal") }
        refuses { bind(f = f.copy(receipt = f.receipt.copy(source = f.receipt.source.copy(accounts = hostile)))) }
    }
    @Test fun `caller mutations during real crypto cannot change already owned preparation and failure`() = runBlocking {
        val original = f; val rents = p.quote.rents.toMutableList(); val accounts = original.receipt.source.accounts.toMutableList()
        val preparation = p.copy(quote = p.quote.copy(rents = rents)); val failure = original.copy(receipt = original.receipt.copy(source = original.receipt.source.copy(accounts = accounts)))
        val pins = trust; val rules = policy; var mutated = false
        RealmFailureDigest.delegateProvider = MessageDigest.getInstance("SHA-256").provider
        RealmFailureDigest.onDigest = { mutated = true; rents.clear(); accounts.clear() }
        val provider = object : Provider("RealmFailureOwnership", 1.0, "Test hook delegates actual SHA-256") {
            init { put("MessageDigest.SHA-256", RealmFailureDigest::class.java.name) }
        }
        check(Security.insertProviderAt(provider, 1) == 1)
        try {
            val result = RealmSaleFailureCrypto.bind(preparation, w, failure, pins, rules)
            assertTrue(mutated); assertEquals(original, result.failure)
        } finally { Security.removeProvider(provider.name); RealmFailureDigest.onDigest = null }
    }

}

/** Trigger input mutation at crypto execution while retaining the real SHA-256 result. */
class RealmFailureDigest : MessageDigestSpi() {
    private val digest = MessageDigest.getInstance("SHA-256", delegateProvider)
    override fun engineUpdate(input: Byte) = digest.update(input)
    override fun engineUpdate(input: ByteArray, offset: Int, len: Int) = digest.update(input, offset, len)
    override fun engineDigest(): ByteArray {
        val callback = onDigest; onDigest = null; callback?.invoke()
        return digest.digest()
    }
    override fun engineReset() = digest.reset()
    companion object {
        lateinit var delegateProvider: Provider
        var onDigest: (() -> Unit)? = null
    }
}
