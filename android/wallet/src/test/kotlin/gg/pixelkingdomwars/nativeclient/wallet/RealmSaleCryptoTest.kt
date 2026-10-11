package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.realmsales.*
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Public fixture bytes from the real SDK/Anchor planner. No private keys or live chain evidence. */
class RealmSaleCryptoTest {
    private val source get() = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/realm-sale-crypto-fixtures.json")).readText()).jsonObject
    private val policy get() = source.getValue("policy").jsonObject.let { p ->
        RealmSaleSigningPolicy(RealmSalesProtocolPolicy.from(JsonObject(p - "kingSpots" - "regularRealmCount")),
            p.getValue("kingSpots").jsonPrimitive.int, p.getValue("regularRealmCount").jsonPrimitive.int)
    }
    private val cases get() = source.getValue("fixtures").jsonArray.map { it.jsonObject }
    private fun p(f: JsonObject = cases.first()) = RealmSalePreparation.from(f.getValue("preparation").jsonObject, policy.protocol)
    private fun w(f: JsonObject = cases.first()) = RealmSaleSignedWire.from(f.getValue("wire").jsonObject)
    private fun s(f: JsonObject = cases.first()) = RealmSaleSettlement.from(p(f), w(f), f.getValue("settlement").jsonObject, policy.protocol)
    private fun trust(p: RealmSalePreparation = p()) = RealmSaleSigningTrust(p.source.genesisHash, p.source.programId, p.terms.developer,
        p.source.programDataSha256, p.source.reviewedDeploymentSlot, p.source.revision)
    private fun bytes(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun digest(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    private fun base64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)
    private fun rejects(block: suspend () -> Unit) { assertThrows(IllegalArgumentException::class.java) { runBlocking { block() } } }
    private suspend fun check(f: JsonObject = cases.first()) = RealmSaleSettlementVerifier.verify(p(f), w(f), s(f), policy)
    private fun mutatedMessage(p: RealmSalePreparation, at: Int): RealmSalePreparation {
        val bytes = bytes(p.quote.messageHex).also { it[at] = (it[at].toInt() xor 1).toByte() }
        return p.copy(quote = p.quote.copy(messageHex = hex(bytes), messageSha256 = digest(bytes)))
    }
    private fun receipt(s: RealmSaleSettlement, bytes: ByteArray): RealmSaleSettlement {
        val accounts = s.receipt.source.accounts.toMutableList(); accounts[5] = accounts[5].copy(dataSha256 = digest(bytes))
        return s.copy(receipt = s.receipt.copy(receiptAccountHex = hex(bytes), source = s.receipt.source.copy(accounts = accounts)))
    }
    @Test fun `all actual SDK setup and recipient alias fixtures preserve exact message wire and receipt ABI`() = runBlocking {
        assertEquals(22, cases.size)
        for (fixture in cases) {
            val p = p(fixture); val w = w(fixture); val prepared = RealmSaleTransaction.prepare(p, policy, trust(p))
            assertArrayEquals(byteArrayOf(1) + ByteArray(64) + bytes(p.quote.messageHex), prepared.unsignedTransaction())
            assertEquals(w.signature, prepared.verifySigned(bytes(w.signedTransactionHex)).signature)
            assertEquals(s(fixture), check(fixture))
        }
    }
    @Test fun `new preparation requires every independent deployment pin while historical verification does not`() = runBlocking {
        val p = p(); val t = trust(p); val other = base58(ByteArray(32) { 19 })
        for (wrong in listOf(t.copy(genesisHash = other), t.copy(programId = other), t.copy(developer = other),
            t.copy(reviewedProgramDataSha256 = "00".repeat(32)), t.copy(reviewedDeploymentSlot = 0), t.copy(revision = "different")))
            rejects { RealmSaleTransaction.prepare(p, policy, wrong) }
        assertEquals(w().signature, RealmSaleTransaction.verifySigned(p, policy, base64(bytes(w().signedTransactionHex))).signature)
    }
    @Test fun `canonical reconstruction rejects every changed message byte even with recomputed declared hash`() = runBlocking {
        val p = p(cases.first { p(it).quote.needsAccess && p(it).quote.needsQuota })
        for (offset in bytes(p.quote.messageHex).indices) rejects { RealmSaleTransaction.prepare(mutatedMessage(p, offset), policy, trust(p)) }
    }
    @Test fun `displayed terms setup plan canonical rent addresses and policy realm mask bind signed instructions`() {
        val p = p(cases.first { p(it).quote.needsAccess && p(it).quote.needsQuota }); val t = trust(p); val other = base58(ByteArray(32) { 19 })
        val rents = p.quote.rents
        val mutations = listOf(p.copy(terms = p.terms.copy(seller = other)), p.copy(terms = p.terms.copy(priorExpiry = "1")),
            p.copy(terms = p.terms.copy(round = "2")), p.copy(realm = 1), p.copy(spot = policy.kingSpots.toLong(), realm = policy.regularRealmCount.toLong()),
            p.copy(quote = p.quote.copy(messageSha256 = "00".repeat(32))), p.copy(quote = p.quote.copy(blockhash = other)),
            p.copy(quote = p.quote.copy(rents = rents.reversed())),
            p.copy(quote = p.quote.copy(rents = rents.toMutableList().also { it[0] = it[0].copy(address = other) })),
            p.copy(quote = p.quote.copy(rents = rents.toMutableList().also { it[0] = it[0].copy(space = 1) })))
        mutations.forEach { rejects { RealmSaleTransaction.prepare(it, policy, t) } }
        rejects { RealmSaleTransaction.prepare(p.copy(wallet = p.source.programId), policy, t) }
        rejects { RealmSaleTransaction.prepare(p.copy(terms = p.terms.copy(seller = "11111111111111111111111111111111")), policy, t) }
    }
    @Test fun `signed envelope verifies exact full bytes real Ed25519 and canonical bounded base64`() = runBlocking {
        val prepared = RealmSaleTransaction.prepare(p(), policy, trust()); val wire = bytes(w().signedTransactionHex)
        for (bad in listOf(wire.copyOf().also { it[1] = (it[1].toInt() xor 1).toByte() }, wire.copyOf().also { it[0] = 2 },
            wire.copyOf().also { it.fill(0, 1, 65) }, wire.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() },
            ByteArray(65), ByteArray(1233), wire + 0.toByte())) rejects { prepared.verifySigned(bad) }
        for (bad in listOf("A".repeat(1648), "!!!!", "AQ==", base64(wire) + "\n")) rejects { prepared.verifySignedBase64(bad) }
    }
    @Test fun `forged buyer signature fails despite self consistent wire hashes and declared signature`() {
        val p = p(); val w = w(); val s = s(); val wire = bytes(w.signedTransactionHex).also { it[1] = (it[1].toInt() xor 1).toByte() }
        val signature = base58(wire.copyOfRange(1, 65)); val hash = digest(wire)
        val forgedWire = w.copy(signedTransactionHex = hex(wire), signature = signature, wireSha256 = hash)
        val forged = s.copy(signature = signature, receipt = s.receipt.copy(signature = signature, signedTransactionSha256 = hash))
        forged.validate(p, forgedWire, policy.protocol)
        rejects { RealmSaleSettlementVerifier.verify(p, forgedWire, forged, policy) }
    }
    @Test fun `every receipt ABI byte is reconstructed even when account hash is recomputed`() {
        val p = p(); val w = w(); val s = s(); val original = bytes(s.receipt.receiptAccountHex)
        for (offset in original.indices) {
            val changed = receipt(s, original.copyOf().also { it[offset] = (it[offset].toInt() xor 1).toByte() })
            changed.validate(p, w, policy.protocol)
            rejects { RealmSaleSettlementVerifier.verify(p, w, changed, policy) }
        }
    }
    @Test fun `existing account identities derive PDAs and declared wire receipt hashes cannot substitute proof`() {
        val f = cases.first { !p(it).quote.needsAccess && !p(it).quote.needsQuota }; val p = p(f); val w = w(f); val s = s(f)
        for (index in listOf(1, 2, 3)) {
            val accounts = s.receipt.source.accounts.toMutableList(); accounts[index] = accounts[index].copy(address = base58(ByteArray(32) { 19 }))
            val changed = s.copy(receipt = s.receipt.copy(source = s.receipt.source.copy(accounts = accounts)))
            changed.validate(p, w, policy.protocol); rejects { RealmSaleSettlementVerifier.verify(p, w, changed, policy) }
        }
        val fakeHash = "ab".repeat(32)
        rejects { RealmSaleSettlementVerifier.verify(p, w.copy(wireSha256 = fakeHash), s.copy(receipt = s.receipt.copy(signedTransactionSha256 = fakeHash)), policy) }
        val accounts = s.receipt.source.accounts.toMutableList(); accounts[5] = accounts[5].copy(dataSha256 = fakeHash)
        rejects { RealmSaleSettlementVerifier.verify(p, w, s.copy(receipt = s.receipt.copy(source = s.receipt.source.copy(accounts = accounts))), policy) }
        val fakeSignature = base58(ByteArray(64) { 17 })
        rejects { RealmSaleSettlementVerifier.verify(p, w.copy(signature = fakeSignature), s.copy(signature = fakeSignature, receipt = s.receipt.copy(signature = fakeSignature)), policy) }
    }
    @Test fun `prepared buffers and verified result lists are owned immutable historical values`() = runBlocking {
        val p = p(); val rents = p.quote.rents.toMutableList(); val input = p.copy(quote = p.quote.copy(rents = rents))
        val prepared = RealmSaleTransaction.prepare(input, policy, trust(p)); rents.clear(); prepared.unsignedTransaction().fill(0)
        val bytes = bytes(w().signedTransactionHex); val signed = prepared.verifySigned(bytes); bytes.fill(0)
        assertEquals(w().signature, signed.signature); assertEquals(w().signature, prepared.verifySignedBase64(signed.wire).signature)
        val accounts = s().receipt.source.accounts.toMutableList(); val original = s().copy(receipt = s().receipt.copy(source = s().receipt.source.copy(accounts = accounts)))
        val result = RealmSaleSettlementVerifier.verify(p, w(), original, policy); accounts.clear()
        assertEquals(6, result.receipt.source.accounts.size)
        assertThrows(UnsupportedOperationException::class.java) { (result.receipt.source.accounts as MutableList).clear() }
        assertThrows(UnsupportedOperationException::class.java) { (result.receipt.accountRentIncreases as MutableList).clear() }
        assertTrue(result.purchaseFinalized); assertFalse(result.signingAuthorized); assertFalse(result.admissionAuthorized); assertFalse(result.relayAuthorized)
    }
}
